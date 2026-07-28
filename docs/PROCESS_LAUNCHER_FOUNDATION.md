# Process Launcher Foundation (Tranche 2A2)

## Boundary

Tranche 2A2 adds a trusted Rust verification service at
`native/process-launcher`. It has exactly three operations:

- `health`
- `getRootfs`
- `verifyExecutable`

It has no launch, execute, spawn, cancel, signal, output, or attach operation. It does
not invoke Bubblewrap, enter namespaces, mutate cgroups, install seccomp, or execute a
configured profile. The Node client is private and is not imported by `server.js`.
`CURRENT_PROCESS_SANDBOX_CAPABILITY` remains `null`.

## Trusted configuration

Configuration version 1 is closed:

```json
{
  "version": 1,
  "socketPath": "/run/ticket-system-process/launcher/launcher.sock",
  "stateRoot": "/var/lib/ticket-system/process-launcher",
  "allowedClientUid": 62002,
  "launcherServiceUid": 62004,
  "materializerServiceUid": 62001,
  "trustedRootfsOwnerUid": 0,
  "delegatedCgroupRoot": "/sys/fs/cgroup/ticket-system-process",
  "healthValidityMs": 30000,
  "rootfsRegistry": [{
    "id": "node-24-fedora-runtime-v1",
    "rootPath": "/var/lib/ticket-system/runtime-rootfs/node-24-fedora-runtime-v1/root",
    "manifestPath": "/var/lib/ticket-system/runtime-rootfs/node-24-fedora-runtime-v1/manifest.json",
    "manifestSha256": "lowercase-sha256"
  }],
  "sandboxBackend": {
    "kind": "bubblewrap",
    "binaryPath": "/usr/bin/bwrap",
    "binarySha256": "lowercase-sha256"
  },
  "seccompPolicyPath": "/etc/ticket-system/process-seccomp-v1.bpf",
  "seccompPolicySha256": "lowercase-sha256",
  "protectedHostPaths": {
    "runtimeData": ["/var/lib/ticket-system/runtime"],
    "materializerState": ["/var/lib/ticket-system/process-inputs"],
    "workspaces": ["/srv/ticket-system/workspace"]
  }
}
```

There are at most 32 rootfs entries. IDs use the frozen 1–128 byte process identifier.
All paths are trusted deployment paths; no request contains a host rootfs path, backend
path, policy path, cgroup path, or service-state path. The runtime, materializer,
launcher, and trusted rootfs owner UIDs must be distinct. `/`, live `/usr`, `/lib`,
`/lib64`, `/bin`, `/home`, and an operator home cannot be a configured rootfs.

The state and socket roots must already exist, be owned by the launcher service, and
have mode `0750`. The launcher creates only its socket and its
`launcher-foundation-instance.lock`. It never creates or repairs rootfs installations.
There is no rootfs deletion or garbage collection operation. Deployment must retain an
installed version and its manifest while any admitted or executing operation references
that `(rootfs ID, manifest SHA-256)` authority.

## Lifetime ownership

Both native services use a descriptor-relative, service-owned `0600` regular lock file
beneath their pinned private state root:

- materializer: `materializer-instance.lock`
- launcher foundation: `launcher-foundation-instance.lock`

Each descriptor is opened with `O_NOFOLLOW | O_CLOEXEC` and held under
`flock(LOCK_EX | LOCK_NB)` for the service lifetime. The materializer acquires its lock
before abandoned-staging cleanup, registry loading, existing-socket removal, or binding.
The launcher acquires its lock before any socket removal or bind. A lock pathname is not
authority and is deliberately retained after shutdown; kernel lock ownership is.

## Rootfs manifest

Manifest version 1 is canonical compact JSON:

```json
{"version":1,"entries":[{"type":"directory","path":"usr","mode":"0555"},{"type":"directory","path":"usr/bin","mode":"0555"},{"type":"regular_file","path":"usr/bin/node","size":123456,"sha256":"lowercase-sha256","mode":"0555"},{"type":"symbolic_link","path":"usr/lib/runtime.so","target":"runtime-v1.so"}]}
```

Directories are explicit. Entries are unique and ordered by raw UTF-8 bytes. Paths are
normalized relative UTF-8 paths with at most 4,096 bytes, 255 bytes per component, and
64 components. Absolute symbolic-link targets are rejected. Relative targets are
lexically checked against escape from the rootfs. Socket, FIFO, block-device,
character-device, and unknown types are rejected.

The initial hard bounds are 100,000 entries, 16 MiB of manifest JSON, and 16 GiB total
regular-file bytes. Every entry must be owned by the trusted deployment UID. Directory
and regular-file modes contain no write, setuid, or setgid bits. File capabilities are
rejected. Regular-file hashes cover exact bytes; symbolic-link targets cover exact UTF-8
target bytes.

At startup the service opens the rootfs and manifest from a trusted `/` descriptor using
`openat2` constraints equivalent to `RESOLVE_BENEATH | RESOLVE_NO_SYMLINKS |
RESOLVE_NO_MAGICLINKS`. It records device, inode, owner, group, and mode. It hashes and
parses the bounded configured manifest, then traverses the complete pinned rootfs
descriptor-relatively and reconstructs the manifest. Missing, additional, retyped,
replaced, writable, privileged, special, or mismatched entries fail closed. Every
subsequent health/rootfs/executable operation revalidates the pinned identities and the
complete tree. Renaming or redirecting the configured pathname cannot redirect a live
generation.

## Private protocol

The Unix protocol uses 4-byte big-endian length framing with a 2,097,152-byte maximum,
closed version-1 messages, socket mode `0660`, and Linux `SO_PEERCRED` validation against
the exact runtime UID. An unauthorized peer is rejected before its payload is read:

```json
{
  "version": 1,
  "requestId": null,
  "ok": false,
  "error": {
    "code": "PROCESS_LAUNCHER_CLIENT_UNAUTHORIZED",
    "message": "Launcher foundation client is not authorized"
  }
}
```

`requestId: null` is valid only for that pre-authentication refusal. All other responses
echo the exact request ID.

`getRootfs` accepts only `{rootfsId, rootfsManifestSha256}`. `verifyExecutable` accepts:

```json
{
  "rootfsId": "node-24-fedora-runtime-v1",
  "rootfsManifestSha256": "lowercase-sha256",
  "executablePath": "/usr/bin/node",
  "executableSha256": "lowercase-sha256",
  "format": "elf"
}
```

The executable path is interpreted only inside the pinned rootfs. It must name the exact
regular-file manifest entry, pass a fresh content-hash check, and begin with the ELF
magic bytes with a supported class, byte order, ELF version, executable/shared-object
type, nonzero machine identity, and at least one execute bit in the manifest mode.
Scripts and shebangs are unsupported. Results contain rootfs IDs,
rootfs-internal executable identities, hashes, counts, and generations, never host paths
or descriptors.

## Generations and prerequisite health

`rootfs-registry-v1-<sha256>` binds:

- protocol version and launcher binary SHA-256;
- canonical complete trusted configuration hash;
- every canonical rootfs manifest hash;
- pinned rootfs and manifest physical identities;
- Bubblewrap bytes and physical identity;
- seccomp policy bytes and physical identity;
- manifest schema version.

The private Node contract combines exact launcher foundation health with exact
materializer health into:

```json
{
  "version": 1,
  "status": "prerequisites_verified",
  "generationId": "sandbox-prerequisite-v1-lowercase-sha256",
  "launcherProtocolVersion": 1,
  "launcherIdentityHash": "lowercase-sha256",
  "sandboxBackendIdentityHash": "lowercase-sha256",
  "seccompPolicyHash": "lowercase-sha256",
  "rootfsRegistryGeneration": "rootfs-registry-v1-lowercase-sha256",
  "hostPrerequisiteIdentityHash": "lowercase-sha256",
  "materializerGeneration": "materializer-v1-lowercase-sha256",
  "verifiedAt": "canonical UTC timestamp",
  "expiresAt": "canonical UTC timestamp",
  "readyForExecution": false
}
```

Expiry is mandatory and capped at five minutes. This descriptor proves complete rootfs,
backend, policy, materializer-generation, and static host-prerequisite identity only. It
does not satisfy the existing healthy sandbox-capability schema and cannot authorize
`runProcess`.

The Linux probe checks the platform/kernel, cgroup v2 filesystem, `cpu`, `memory`, and
`pids` controller presence, pinned delegated cgroup directory, nonzero user-namespace
availability, mount/PID/network namespace handles, seccomp action availability, and
`no_new_privs` kernel support. These are labelled `statically_present`.

Tranche 2A3 must actively prove namespace creation, network denial, cgroup placement and
limits, seccomp installation, blocked-child release, whole-tree termination, and every
resource-enforcement result. No 2A2 status is an active containment proof.

## Typed failures

- `PROCESS_MATERIALIZER_ALREADY_RUNNING`
- `PROCESS_LAUNCHER_FOUNDATION_UNAVAILABLE`
- `PROCESS_LAUNCHER_CLIENT_UNAUTHORIZED`
- `PROCESS_LAUNCHER_PROTOCOL_INVALID`
- `PROCESS_LAUNCHER_ALREADY_RUNNING`
- `PROCESS_ROOTFS_REGISTRY_INVALID`
- `PROCESS_ROOTFS_UNKNOWN`
- `PROCESS_ROOTFS_UNAVAILABLE`
- `PROCESS_ROOTFS_MANIFEST_INVALID`
- `PROCESS_ROOTFS_MANIFEST_MISMATCH`
- `PROCESS_ROOTFS_ENTRY_INVALID`
- `PROCESS_ROOTFS_IDENTITY_CHANGED`
- `PROCESS_EXECUTABLE_IDENTITY_MISMATCH`
- `PROCESS_EXECUTABLE_FORMAT_UNSUPPORTED`
- `PROCESS_SANDBOX_BACKEND_INVALID`
- `PROCESS_SECCOMP_POLICY_INVALID`
- `PROCESS_SANDBOX_PREREQUISITES_UNAVAILABLE`
- `PROCESS_SANDBOX_PREREQUISITES_EXPIRED`

No failure produces a healthy execution capability.

## Deployment and release proof

The systemd/tmpfiles examples use dedicated `ticket-system-materializer` and
`ticket-system-launcher` users, a runtime client group, separate service-owned `0750`
socket subdirectories, fixed absolute binaries/configuration, root-owned read-only
rootfs/config/seccomp authority, and no application environment file or credentials.
The launcher unit is hardening for the trusted verifier; it is not the future process
sandbox.

`scripts/process-launcher-foundation-cross-uid-test.js` is mandatory for a
process-enabled release. Run it in dedicated Linux CI as root:

```sh
sudo env PROCESS_LAUNCHER_CROSS_UID_REQUIRED=1 \
  node scripts/process-launcher-foundation-cross-uid-test.js
```

An environment without root or a functioning subordinate multi-UID mapping reports the
test as blocked. It may not substitute a same-UID chmod test.
