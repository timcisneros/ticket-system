# Bounded process execution contract — Tranche 2 complete

Tranches 2A0–2A3 froze executable authority, immutable input, verified rootfs identity,
and the native kernel-containment launcher. Tranche 2B connects only authorized
version-3 requests to that launcher through a PostgreSQL-backed, exactly-once,
recoverable lifecycle. Version-1 and version-2 process-policy snapshots remain readable
historical records and are permanently non-executable. A version-3 snapshot is
dispatchable only while the feature flag, lifecycle storage, artifact storage,
materializer, rootfs authority, and fresh active-containment generation all resolve to
one closed runtime capability.

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
comparator, hashed with canonical JSON, and deeply frozen. The snapshot alone is never
dispatch authority. `processAuthorityReferences` projects version-3 target/profile
references only when a current closed runtime capability is supplied and the profile
permits the current phase.

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

The model-safe projection shape is:

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

The live runtime advertises it only for version-3 snapshots while a fresh runtime
capability of the same admitted generation is healthy. Historical version-2 snapshots
remain readable by the contract and preserve their direct executor-unavailable refusal,
but the live runtime does not advertise them as executable actions. Executable paths,
arguments, working directories, environment values, limits, launch plans, and native
identities never enter the model envelope.

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

Version-3 resolution has mandatory current sandbox and runtime capability gates. With
either gate missing, a hidden or direct request is denied. Missing sandbox health
resolves exactly as:

```json
{
  "code": "PROCESS_SANDBOX_UNAVAILABLE",
  "disposition": "policy_denied",
  "authorityStatus": "denied",
  "terminalOutcome": "policy_denied"
}
```

It records `authority.denied`, never `authority.allowed`. Missing, malformed, unhealthy,
future-dated, or stale sandbox data has the same fail-closed result. A healthy sandbox
without matching runtime lifecycle capability is denied as
`PROCESS_RUNTIME_CAPABILITY_UNAVAILABLE`. Only exact current sandbox and runtime
generations produce `PROCESS_EXECUTION_AUTHORIZED`; the controller still revalidates
both immediately before launch. Historical version-2 requests retain their
executor-unavailable compatibility behavior and can never create launch plans.

Tranche 2A3's private active containment descriptor is closed and time-bounded:

```json
{
  "version": 1,
  "status": "containment_verified",
  "generationId": "sandbox-containment-v1-lowercase-sha256",
  "launcherProtocolVersion": 1,
  "launcherIdentityHash": "lowercase-sha256",
  "sandboxBackendIdentityHash": "lowercase-sha256",
  "seccompPolicyHash": "lowercase-sha256",
  "rootfsRegistryGeneration": "rootfs-registry-v1-lowercase-sha256",
  "materializerGeneration": "materializer-v1-lowercase-sha256",
  "delegatedCgroupIdentityHash": "lowercase-sha256",
  "containmentProbeHash": "lowercase-sha256",
  "verifiedAt": "canonical UTC timestamp",
  "expiresAt": "canonical UTC timestamp",
  "readyForExecution": true
}
```

Generation identifiers use the process identifier contract. Protocol versions are
positive and at most 16. Validity is positive and at most five minutes, and the
descriptor is usable by the private launcher only between `verifiedAt` and `expiresAt`.
It is produced only after the active 2A3 cgroup, namespace, network, seccomp, output,
timeout, tree-death, resource, and fixed Node probes pass. The static
`CURRENT_PROCESS_SANDBOX_CAPABILITY` remains `null`; the runtime never trusts a mutable
process-global health value. Tranche 2B instead resolves and expires native health for
each admission, envelope, and new submission.

`operationId` identifies one process request within a run; it is not globally unique.
The runtime hashes `(runId, operationId)` into the canonical process operation identity.
Request-resolution evidence preserves the first authorization result exactly. Once
execution intent exists, that operation identity is also the PostgreSQL and native
launcher idempotency key. Exact retries reconcile the stored plan and operation;
different target/profile reuse fails with `PROCESS_OPERATION_ID_CONFLICT`, and different
launch authority under the same identity fails with
`PROCESS_EXECUTION_INTENT_CONFLICT`. Neither runtime nor launcher may relaunch an
accepted or terminal identity.

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

Allowed causes are `memory`, `process_count`, `open_files`, `file_size`, and
`temporary_storage`. A resource-limit outcome requires an established process identity
and ownership identity. `cpuQuotaMicrosPer100ms` is a cgroup rate throttle, not a total
CPU budget; throttling is recorded but is never a terminal `cpu` cause.

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
and `getSnapshot` revalidates every ownership field, the exact canonical
`filesystemPolicyHash`, manifest, count, and byte total. Workspace allocation, sealed
state, and socket roots are pinned as startup descriptors rather than reopened from
configured path strings. Allocation physical identity participates in the generation.
The sealed and socket roots are pre-provisioned by the checked-in systemd/tmpfiles
deployment boundary. An unauthorized peer receives only the fixed uncorrelated
`requestId: null` refusal before any request bytes are read.
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
    "generationId": "sandbox-containment-v1-lowercase-sha256",
    "launcherProtocolVersion": 1,
    "launcherIdentityHash": "lowercase-sha256",
    "sandboxBackendIdentityHash": "lowercase-sha256",
    "seccompPolicyHash": "lowercase-sha256",
    "rootfsRegistryGeneration": "rootfs-registry-v1-lowercase-sha256",
    "materializerGeneration": "materializer-v1-lowercase-sha256",
    "delegatedCgroupIdentityHash": "lowercase-sha256",
    "containmentProbeHash": "lowercase-sha256"
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

Enforcement uses an isolated network namespace, no host interfaces or socket mounts, no
inherited sockets, and syscall filtering for external network families and host
connection paths. The contract deliberately does not require denial of unnamed
operation-local IPC such as Unix `socketpair`; that is not external communication and may
be required by a configured runtime. Standard input remains disabled, no PTY may be
allocated, and detached execution is forbidden.

## Verified launcher, active containment, and dispatch boundary

Tranche 2A3 extends the verified Rust foundation documented in
`docs/PROCESS_LAUNCHER_FOUNDATION.md`. The authenticated, bounded protocol now includes
private `launch`, `getOperation`, and `cancelOperation` in addition to rootfs and ELF
verification. Node supplies no host mount path, raw Bubblewrap/seccomp option, raw cgroup
name, PID, command string, or shell. The launcher obtains sealed workspace descriptors
directly from the materializer with `SCM_RIGHTS`.

The enforced pre-execution barrier is:

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

## Runtime capability and durable lifecycle

The runtime capability is a closed, expiring descriptor:

```json
{
  "version": 1,
  "status": "runtime_verified",
  "generationId": "process-runtime-v1-lowercase-sha256",
  "controllerProtocolVersion": 1,
  "databaseSchemaVersion": 29,
  "artifactPublicationContractVersion": 1,
  "containmentGenerationId": "sandbox-containment-v1-lowercase-sha256",
  "materializerGeneration": "materializer-v1-lowercase-sha256",
  "rootfsRegistryGeneration": "rootfs-registry-v1-lowercase-sha256",
  "launcherProtocolVersion": 1,
  "verifiedAt": "canonical UTC timestamp",
  "expiresAt": "canonical UTC timestamp",
  "readyForExecution": true
}
```

The resolver requires the default-off feature flag, migration 029, writable artifact
storage, current materializer health, current active containment health, matching
materializer/rootfs/launcher generations, exact rootfs and ELF verification for every
profile, and all mandatory process release gates. The stable generation hash covers
controller protocol, database schema, artifact contract, containment, materializer,
rootfs registry, and launcher protocol. Refreshing unchanged authority may extend
expiry without changing the generation. Changed or expired authority refuses a new
launch. Existing accepted operations remain launcher-owned and are reconciled rather
than relaunched.

Migration 029 adds one `process_operations` row per
`process-operation:<sha256(runId,operationId)>`. Its immutable columns bind run, ticket,
acting agent, step, phase, target/profile, policy and runtime generations, canonical
private launch plan and hash, workspace/materializer, containment, rootfs/ELF, and fixed
execution/filesystem policy hashes. It stores no host path, raw output, secret, ambient
environment, cgroup path, or PID authority.

The lifecycle is:

```text
intent → active → finalizing → terminal
```

- `intent` is committed before any launcher request.
- `active` requires the launcher's durable acceptance identity.
- `finalizing` contains one validated terminal-result hash and terminal facts while
  artifacts or required evidence remain incomplete.
- `terminal` requires complete artifacts where output is available and complete required
  evidence.

Cancellation is an orthogonal durable fact. Every transition is revision-guarded
compare-and-set; a PostgreSQL transaction-scoped advisory lock serializes intent
creation, and the existing session advisory-lock family serializes runtime reconciliation.
A trigger makes authority immutable, forbids deletion and backward transitions, and
requires the revision to advance exactly once.

## Launcher durable registry and output transfer

The launcher owns a bounded registry of 4,096 canonical, fsynced operation records under
its pinned private state root. Acceptance is persisted before the blocked child is
released. Each record binds operation identity, launch-plan hash, containment generation,
workspace manifest, rootfs manifest, ELF hash, aggregate authority hash, acceptance
identity, start facts, terminal facts/hash, and output acknowledgement. Exact replay
returns the existing accepted, active, or terminal record; conflicting authority fails.
Registry corruption or capacity exhaustion fails closed.

After launcher restart, any accepted or active record without a durable terminal result
becomes `runtime_interrupted`; it is never executed again. Terminal tombstones survive
output cleanup so an operation identity cannot be reused. The authenticated protocol
adds:

```text
readOutput(operationIdentity, stream, offset, maximumBytes,
           expectedTotalBytes, expectedSha256)
acknowledgeOutput(operationIdentity, terminalResultHash)
```

Only immutable terminal stdout/stderr are readable. Chunks are at most 65,536 raw bytes,
base64-encoded on the wire, and bound to exact operation, stream, offset, total, and
SHA-256 authority. No host path is returned. Acknowledgement persists the tombstone
before private output deletion.

The Node artifact publisher streams each output independently, computes raw byte count
and SHA-256 again, writes a private temporary file, fsyncs it, removes write permission,
and uses a no-replace hard-link publication. Artifacts live under an operation-identity
hash, outside the child mount view. Empty streams produce the same immutable zero-byte
artifact contract. PostgreSQL stores only artifact identity, relative artifact reference,
count, and hash—not raw output.

## Evidence, receipts, cancellation, and recovery

The controller publishes idempotent append-only evidence for
`process.intent_admitted`, `process.launcher_accepted`, `process.terminal`,
`process.stdout_artifact`, `process.stderr_artifact`, and
`process.cancellation_requested`. Each binds run/ticket/operation, launch plan, policy,
runtime/containment/materializer generations, rootfs/ELF authority, workspace snapshot
and manifest, terminal-result hash, and artifact counts/hashes. A generic
`run_operations` receipt records `runProcess`, participates in replay and consequence
reconstruction, and does not create special ticket-completion semantics.

Output acknowledgement occurs only after artifacts, database terminal facts, required
evidence, and the generic receipt are durable. Evidence or artifact failure leaves the
row recoverably `finalizing`; it cannot be reported as successful.

Run interruption and lease loss first durably request cancellation, call the exact
launcher operation, observe whole-tree terminalization, finish output/evidence, and only
then terminalize the run. Cancellation before launcher acceptance produces a truthful
zero-output cancelled result without launch. Cancellation racing natural completion
reconciles the launcher's single terminal result.

Startup scans every nonterminal operation. `intent` queries the launcher before any
submission and submits the exact stored plan only when no acceptance exists and current
authority still permits it. `active` reattaches; `finalizing` completes artifacts and
evidence; `terminal` repairs only acknowledgement/idempotent evidence. Launcher loss
never fabricates exit facts or triggers a relaunch. Scheduler lease expiry uses the same
cancellation path.

The deterministic recovery gate interrupts each required crash boundary: after intent,
after launcher acceptance, after child release, after launcher terminal, during stdout
transfer, after artifact publication, after terminal-fact persistence, after required
evidence, during cancellation, and during startup reconciliation. Each restart converges
to one execution, one terminal row, one artifact pair, one receipt/evidence set, and one
launcher acknowledgement.

Tranche 2 is closed. Kernel containment and active proof completed the original sandbox
work commonly associated with Tranche 4; this tranche completes the durable execution,
idempotency, artifact, cancellation, and recovery work commonly associated with
Tranche 3. Neither capability should be rebuilt as a parallel subsystem.
