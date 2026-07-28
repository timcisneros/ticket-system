# Trusted process-input materializer — Tranche 2A1

Tranche 2A1 implements one transformation and no execution:

```text
mutable shared workspace
→ PostgreSQL workspace-root mutation boundary
→ authenticated native materializer
→ descriptor-relative copy and source revalidation
→ canonical manifest
→ service-owned sealed tree and durable private registry
→ bound public workspaceSnapshot descriptor
```

The materializer does not launch a process, invoke a shell, map a rootfs, probe sandbox
health, or enter model dispatch. `CURRENT_PROCESS_SANDBOX_CAPABILITY` remains `null`.

## Workspace mutation boundary

The deployment has one physical `WORKSPACE_ROOT`; ticket/run scopes are logical views of
that shared root. `PostgresRuntimeStore.withTargetOperationLock` already serializes agent
mutations and recovered mutations with hierarchical PostgreSQL advisory locks. Every
ordinary path mutation takes the shared root resource
`workspace:<target-id>:` plus exclusive path resources.

`withWorkspaceMutationBoundary` is the exclusive root member of that same lock family.
Materialization holds it from authority resolution through `getSnapshot` verification.
Operator create/write/rename/delete routes now use the path-lock family. Fixture and
debug resets use the exclusive root boundary. Recovery continues through
`withOperatorRecoveryLock`, which delegates to the same target-operation lock.

This boundary works between PostgreSQL-connected runtime processes; it is not an
in-memory mutex and is not merely a caller-supplied token. External host writers do not
participate in it, so the native service independently rescans and rehashes the source
before publication.

## Native service and trusted configuration

The service is Rust in `native/process-materializer`. Rust supplies typed closed
contracts and direct Linux descriptor/syscall access without adding a child-process
runtime. The private registry uses canonical, fsynced JSON records and atomic renames
rather than adding a second embedded database. Registry files are boring,
independently inspectable service state, while startup validates the complete
registry/tree correspondence.

The closed version-1 service configuration is:

```json
{
  "version": 1,
  "socketPath": "/run/ticket-system-process/materializer/materializer.sock",
  "sealedSnapshotRoot": "/var/lib/ticket-system/process-inputs",
  "allowedClientUid": 1000,
  "inputPolicyPath": "/etc/ticket-system/process-input-policy.json",
  "workspaceAllocations": [
    {
      "id": "primary-workspace",
      "sourceRoot": "/srv/ticket-system/workspace"
    }
  ],
  "protectedHostPaths": {
    "runtimeData": ["/var/lib/ticket-system/runtime"],
    "artifacts": ["/var/lib/ticket-system/artifacts"],
    "database": ["/run/postgresql"]
  }
}
```

The checked-in example contains deployment placeholders, not an operator home path.
All paths are normalized absolute trusted configuration with a 4,096-byte ceiling.
There may be at most 32 uniquely identified workspace allocations. Allocation IDs use
the frozen 1–128-byte process identifier syntax. Source roots must exist as directories.
The sealed root may not equal, contain, or be contained by a source root, runtime-data
path, artifact path, database path, or the socket. Every source root is also checked
against the sealed-storage boundary after filesystem resolution.

The deployment must pre-provision the sealed root and the `0750` socket directory with
the materializer service as owner. The service never creates or chmods either trusted
top-level root. It rejects group- or world-writable sealed storage, requires socket
directory mode `0750`, and rejects symbolic or magic links in every path component.
Only the service's internal state directories and `0660` socket entry are created.

At startup each workspace allocation, the sealed root, and the socket directory are
opened from `/` with `openat2` and `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS |
RESOLVE_NO_MAGICLINKS`. The service retains those descriptors. Allocation device,
inode, owner, group, and mode evidence participates in the materializer generation;
duplicate physical allocation roots are rejected. Materialization duplicates the
retained allocation descriptor and never reopens `sourceRoot`. Sealed operations remain
relative to the retained state descriptor, and socket creation is relative to the
retained socket-directory descriptor. Replacing a configured pathname cannot redirect a
running generation.

Each connection is authenticated with Linux `SO_PEERCRED` against the exact configured
service UID.
The Node process only receives the socket path and a trusted allocation ID; it cannot
name a source root, sealed root, staging path, or final host path.

## Protocol

Messages use a four-byte unsigned big-endian length followed by UTF-8 JSON. Version 1
has a 2,097,152-byte maximum. The length is rejected before payload allocation.
Envelopes and bodies are closed and reject unknown fields.

An unauthorized peer is rejected before the service reads its request frame. The only
uncorrelated response is:

```json
{
  "version": 1,
  "requestId": null,
  "ok": false,
  "error": {
    "code": "PROCESS_MATERIALIZER_CLIENT_UNAUTHORIZED",
    "message": "Materializer client is not authorized"
  }
}
```

`requestId: null` is invalid for every other response. Every authenticated response
echoes the exact request ID. The refusal never includes the rejected numeric UID.

The only operations are:

- `health` with body `{}`; returns the materializer-generation record.
- `materialize` with the body below; returns a public descriptor.
- `getSnapshot` with expected ownership fields; returns the same public descriptor.

The exact materialization body is:

```json
{
  "workspaceAllocationId": "primary-workspace",
  "runId": 123,
  "ticketId": 45,
  "operationId": "operation-001",
  "operationIdentity": "process-operation:lowercase-sha256",
  "policySnapshotHash": "lowercase-sha256",
  "materializerGeneration": "materializer-v1-lowercase-sha256",
  "filesystemPolicy": {
    "inputMode": "materialized_read_only",
    "writableRoots": [],
    "allowSymlinks": false,
    "allowSpecialFiles": false,
    "maxInputFiles": 10000,
    "maxInputBytes": 268435456
  }
}
```

The Node request builder derives `operationIdentity` from `(runId, operationId)`, and
the service recomputes it independently. The service accepts only the frozen read-only
filesystem policy and independently enforces the 10,000-file and 268,435,456-byte hard
ceilings. Paths, commands, executables, environment, mount, sandbox, and destination
options cannot be represented.

`getSnapshot` requires:

```json
{
  "snapshotId": "snapshot-lowercase-random-hex",
  "expectedRunId": 123,
  "expectedTicketId": 45,
  "expectedOperationId": "operation-001",
  "expectedOperationIdentity": "process-operation:lowercase-sha256",
  "expectedPolicySnapshotHash": "lowercase-sha256",
  "expectedMaterializerGeneration": "materializer-v1-lowercase-sha256",
  "expectedFilesystemPolicyHash": "lowercase-sha256"
}
```

It recomputes operation identity and validates the registry record, sealed tree,
manifest, counts, ownership fields, policy, and current generation before returning.
Another operation in the same run cannot substitute its snapshot.

## Materializer generation

At startup the service hashes:

- protocol version;
- SHA-256 of the installed materializer binary;
- SHA-256 of canonical process-input exclusion policy;
- SHA-256 of the complete canonical trusted service configuration, including the exact
  client UID, workspace allocations, storage/socket boundaries, and protected host paths;
- canonical allocation IDs plus the pinned source-root device, inode, owner, group, and
  mode evidence;
- manifest schema version; and
- registry schema version.

The generation identifier is `materializer-v1-<64 lowercase hex>`. Health returns
exactly:

```json
{
  "materializerGeneration": "materializer-v1-lowercase-sha256",
  "materializerIdentityHash": "lowercase-sha256",
  "inputPolicyHash": "lowercase-sha256",
  "filesystemPolicy": {
    "inputMode": "materialized_read_only",
    "writableRoots": [],
    "allowSymlinks": false,
    "allowSpecialFiles": false,
    "maxInputFiles": 10000,
    "maxInputBytes": 268435456
  },
  "filesystemPolicyHash": "lowercase-sha256",
  "manifestSchemaVersion": 1,
  "registrySchemaVersion": 1
}
```

Any authority-relevant change produces another generation. The materializer request,
registry record, public descriptor, and future sandbox capability all bind this ID.

## Input exclusion policy

`config/process-input-policy.json` is distinct from
`config/protected-paths.json`. Protected paths govern which repository paths agents may
mutate; process-input exclusions govern which bytes untrusted future code may read.
Consequently ordinary project manifests and lockfiles remain valid read-only input even
when mutation policy protects them.

Version 1 excludes `.git`, `.env` and `.env.*`, `node_modules`, `ARCHIVE`, data/runtime,
replay and artifact directories, runtime/socket paths, socket suffixes, and common
temporary editor/swap suffixes. The policy has closed bounded lists, exact bytewise
matching, canonical sorting, its own hash, and is recorded in each registry record.
Special files are rejected regardless of their names.

## Traversal, path, and race contract

The configured source root is opened from trusted configuration with `O_DIRECTORY`,
`O_NOFOLLOW`, and `O_CLOEXEC`. Every descendant is opened relative to retained directory
descriptors using Linux `openat2` with:

```text
RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS | RESOLVE_NO_MAGICLINKS
```

Traversal accepts directories and regular files only. Symbolic and magic links, FIFOs,
Unix sockets, block devices, character devices, and every other special type are
rejected. File copying uses an already-open descriptor; it does not `stat` then reopen
the pathname. Before and after copying, device, inode, type, and size are checked.

Input names must be exact valid UTF-8 bytes with no NUL or ASCII control characters.
There is no Unicode normalization or case folding. `/` is the only separator; empty,
`.` and `..` components are invalid. Components are at most 255 bytes, complete paths
at most 4,096 bytes, and directory depth at most 64. Canonical ordering is unsigned
bytewise UTF-8 ordering. Non-UTF-8 names fail with
`PROCESS_INPUT_FILENAME_UNSUPPORTED`; this is an initial process-input limitation, not a
general workspace restriction.

The first pass retains source device/inode/type/size evidence and hashes bytes while
copying. After the output manifest is complete, a fresh descriptor-relative traversal
reconstructs the source manifest and rehashes every source file. Any added, removed,
replaced, resized, retyped, or content-changed file produces
`PROCESS_INPUT_SOURCE_CHANGED`; the service publishes no descriptor or registry record
and does not retry the request silently.

## Normalization, manifest, registry, and sealing

The service copies bytes into service-owned staging storage. It does not use hard links,
symlinks, bind references, reflinks, or source path references. Files are mode `0440`;
directories inside the tree are mode `0550`. Source owner, write/execute/setuid/setgid
bits, capabilities, ACLs, extended attributes, and timestamps are not preserved.

Directories are explicit manifest entries so empty directories are represented:

```json
{
  "version": 1,
  "entries": [
    {
      "path": "src",
      "type": "directory",
      "mode": "0550"
    },
    {
      "path": "src/server.js",
      "type": "regular_file",
      "size": 12345,
      "sha256": "lowercase-sha256",
      "mode": "0440"
    }
  ]
}
```

Paths are unique and bytewise ordered. `fileCount` counts all manifest input entries,
including explicit directories, so it exactly equals `entries.length`; excluded entries
do not consume profile authority. The service separately caps every source entry visited
to prevent exclusion-heavy trees from bypassing the hard traversal bound. `totalBytes`
is the exact regular-file size sum. The canonical manifest itself may not exceed
2,097,152 bytes. SHA-256 covers copied bytes; `manifestSha256` covers canonical JSON
bytes describing the sealed output.

Publication is:

```text
create service-private staging wrapper and tree
→ descriptor-relative copy and output hash
→ write canonical manifest
→ fsync files and directories
→ rescan and compare source
→ atomically rename wrapper to a service-generated random snapshot ID
→ fsync the sealed parent
→ atomically write and fsync the canonical registry record
→ return the descriptor
```

Snapshot IDs are `snapshot-` plus 64 cryptographically random lowercase hex characters.
They reveal no run, ticket, operation, source, or objective. The wrapper and registry
are service-owned and inaccessible to the runtime UID; the normalized input tree is
read-only. A registry-commit failure moves the tree to private quarantine and returns no
descriptor.

The private version-1 record contains exactly:

```json
{
  "version": 1,
  "snapshotId": "snapshot-lowercase-random-hex",
  "state": "sealed",
  "runId": 123,
  "ticketId": 45,
  "operationId": "operation-001",
  "operationIdentity": "process-operation:lowercase-sha256",
  "workspaceAllocationId": "primary-workspace",
  "policySnapshotHash": "lowercase-sha256",
  "materializerGeneration": "materializer-v1-lowercase-sha256",
  "materializerIdentityHash": "lowercase-sha256",
  "inputPolicyHash": "lowercase-sha256",
  "manifestSchemaVersion": 1,
  "manifestSha256": "lowercase-sha256",
  "fileCount": 123,
  "totalBytes": 456789,
  "createdAt": "canonical UTC timestamp"
}
```

Registry records do not contain source or sealed paths; the service derives its private
tree location from the trusted sealed root and random ID. Startup removes abandoned
staging trees, rejects malformed/noncanonical records, missing registered trees, and
sealed trees without matching records, and validates every registered tree and manifest.
Partial state is never reinterpreted as sealed. Garbage collection is intentionally not
part of 2A1.

`filesystemPolicyHash` is SHA-256 over canonical JSON for the exact normalized private
`filesystemPolicy`. Startup recomputes it. Exact materialization replay requires the
complete policy and hash to match; stricter or broader limits under the same operation
identity produce `PROCESS_INPUT_SNAPSHOT_MISMATCH`. `getSnapshot` carries the expected
hash derived from the selected immutable version-3 profile. The public descriptor is
unchanged.

The only public descriptor is:

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

No host path or private registry field is returned. Tranche 2A2 must consume a trusted
registry lookup rather than allowing the runtime to translate this ID into a path.

## Failures and release proof

The stable failures are:

- `PROCESS_MATERIALIZER_UNAVAILABLE`
- `PROCESS_MATERIALIZER_PROTOCOL_INVALID`
- `PROCESS_MATERIALIZER_CLIENT_UNAUTHORIZED`
- `PROCESS_MATERIALIZER_REQUEST_INVALID`
- `PROCESS_WORKSPACE_MUTATION_BOUNDARY_UNAVAILABLE`
- `PROCESS_WORKSPACE_ALLOCATION_UNKNOWN`
- `PROCESS_INPUT_POLICY_INVALID`
- `PROCESS_INPUT_PATH_INVALID`
- `PROCESS_INPUT_FILENAME_UNSUPPORTED`
- `PROCESS_INPUT_SYMLINK_REJECTED`
- `PROCESS_INPUT_SPECIAL_FILE_REJECTED`
- `PROCESS_INPUT_LIMIT_EXCEEDED`
- `PROCESS_INPUT_SOURCE_CHANGED`
- `PROCESS_INPUT_STORAGE_UNAVAILABLE`
- `PROCESS_INPUT_MANIFEST_INVALID`
- `PROCESS_INPUT_SNAPSHOT_SEAL_FAILED`
- `PROCESS_INPUT_SNAPSHOT_NOT_FOUND`
- `PROCESS_INPUT_SNAPSHOT_MISMATCH`
- `PROCESS_INPUT_REGISTRY_INVALID`
- `PROCESS_INPUT_GENERATION_MISMATCH`

No failure returns a public descriptor.

## Production service boundary

The deployment examples are:

- `deployment/systemd/ticket-system-process-materializer.service`
- `deployment/systemd/ticket-system-process-materializer.tmpfiles`

The tmpfiles example pre-provisions the root-owned
`/run/ticket-system-process` parent and the service-owned
`/run/ticket-system-process/materializer` and
`/var/lib/ticket-system/process-inputs` roots as `0750`. The service-owned roots use the
dedicated `ticket-system-materializer` user with the `ticket-system-runtime` group. It also pins
root-owned `0640` configuration and input-policy files. The unit uses a fixed absolute
binary and configuration path, no shell or environment file, and exposes only the
workspace read path plus the two required write roots. This hardens the trusted
materializer service; it does not claim to sandbox future executed code.

The Linux integration suite tests the real native binary, Unix framing, `SO_PEERCRED`,
`openat2`, source races, fsync/rename publication, restart cleanup, and registry/tree
integrity. `process-materializer-cross-uid-test.js` is the required proof that the
materializer UID owns the tree, the runtime UID cannot mutate or delete it, and another
UID cannot use the socket. It needs root or a subordinate multi-UID user namespace.
When `ENABLE_PROCESS_EXECUTION_CONTRACT=true` or
`PROCESS_MATERIALIZER_CROSS_UID_REQUIRED=1`, inability to run that proof fails the
release; a process-enabled production release cannot silently skip it.

The service also holds `materializer-instance.lock` beneath the pinned sealed root using
a descriptor-relative `O_NOFOLLOW | O_CLOEXEC` open and
`flock(LOCK_EX | LOCK_NB)`. It acquires this lease before staging cleanup, registry
loading, socket removal, or bind and retains the descriptor for its lifetime. A second
instance therefore cannot replace the active socket or mutate active staging/registry
state. The lock pathname remains after shutdown; only the kernel-held lease is
authoritative.
