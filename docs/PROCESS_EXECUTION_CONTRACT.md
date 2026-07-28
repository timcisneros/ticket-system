# Bounded process execution contract — Tranche 0

Tranche 0 freezes the process-operation authority, request, outcome, evidence, and
historical-policy contracts. It does not provide an executor and cannot start a process.

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
Every admitted run stores an immutable `processPolicySnapshot`; Tranche 0 snapshots
contain no grants because there is no process target/profile catalog yet. Future target
configuration resolution belongs at run admission and must populate the target/profile
references and their resolved authority material inside this same versioned snapshot.
Dispatch reads the run snapshot, never mutable live target configuration.

The snapshot is stored in the PostgreSQL run JSONB body as
`run.processPolicySnapshot`, included in the append-only `run.created` event, and copied
to `replaySnapshot.processPolicySnapshot`. Its `snapshotHash` is the authority reference
used by process evidence. Later configuration changes cannot rewrite any of those
historical values.

The capability gate is `ENABLE_PROCESS_EXECUTION_CONTRACT=true`. It is false by
default. A process action is model-visible only when the run's captured snapshot says
the capability was enabled and contains at least one explicit target/profile reference.

## Model request

The established direct-action envelope is retained:

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

Both the action object and `args` are closed schemas. The model cannot supply a command,
executable path, argument vector, environment, working directory, shell syntax,
redirection, pipeline, timeout, resource limit, background option, or detached option.
Trusted target configuration will resolve those values in a later tranche.

In Tranche 0 a valid request has exactly one terminal dispatch disposition:

- `disabled` when the run snapshot captured the default-off capability;
- `policy_denied` for an unknown/ungranted target or profile;
- `unsupported` for an explicitly granted target/profile, because no executor exists.

## Terminal outcome taxonomy

Future executor evidence must preserve these distinct outcomes:

- `completed` — the process started and exited successfully.
- `failed_to_start` — the runtime attempted start but no process was established.
- `exited_nonzero` — the process exited normally with a non-zero status.
- `signaled` — the process ended because of a signal or platform equivalent.
- `timed_out` — a configured runtime deadline caused termination.
- `cancelled` — an authorized cancellation caused termination.
- `output_limit_exceeded` — a configured stdout/stderr bound caused enforcement.
- `policy_denied` — authority resolution refused the operation before execution.
- `runtime_interrupted` — runtime ownership ended unexpectedly or during shutdown/recovery.

These values are process terminal outcomes, not replacements for the existing operation
receipt outcomes (`succeeded`, `failed`, and `refused`) or run terminal statuses.

## Evidence

`runtime/process-execution-contract.js` is the machine-readable field authority.
Fields unavailable for a particular outcome may be absent or null, consistent with
current replay/event conventions.

Pre-execution identity:

- `operationId`, `runId`, `ticketId`, `targetId`, `profileId`
- `resolvedExecutable`, `argumentVector`, `workingDirectory`
- `declaredEnvironmentVariableNames` — names only; values and secrets are forbidden
- `policySnapshotHash`
- `startedAt`

Terminal evidence:

- `finishedAt`, `durationMs`
- `pid`, `processGroupId`
- `exitCode`, `terminatingSignal`, `terminalOutcome`, `enforcementCause`
- `stdoutByteCount`, `stderrByteCount`
- `stdoutTruncated`, `stderrTruncated`
- `stdoutArtifactRef` or bounded `stdoutInline`
- `stderrArtifactRef` or bounded `stderrInline`

Process output is recorded only as bounded evidence. It cannot alter or justify the
authority decision that preceded execution.
