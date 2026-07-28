# Native process launcher and containment (Tranche 2A3)

## Boundary

The Rust service in `native/process-launcher` is the private launcher used by the
standalone Tranche 2A3 integrity gate. It is not imported by `server.js`, is not reachable
from model dispatch, and writes no PostgreSQL process-lifecycle evidence.
`CURRENT_PROCESS_SANDBOX_CAPABILITY` remains `null`; model `runProcess` requests remain
denied with `PROCESS_SANDBOX_UNAVAILABLE`.

The authenticated protocol exposes only:

- `health`
- `getRootfs`
- `verifyExecutable`
- `launch`
- `getOperation`
- `cancelOperation`

There is no generic command, shell, host-path, raw Bubblewrap, raw seccomp, raw cgroup,
PID-selection, attach, signal, or output-content operation.

## Deployment identity and cgroup delegation

The launcher unit runs as `ticket-system-launcher`, with
`ticket-system-process-handoff` as its primary group and
`ticket-system-runtime` as a supplementary socket-access group. The materializer uses
the same handoff group. The application runtime is not a member of that group.

The unit uses:

```ini
Delegate=cpu memory pids
TasksMax=infinity
KillMode=control-group
```

The launcher does not trust a configured `/sys/fs/cgroup` path. At startup it reads its
unified cgroup from `/proc/self/cgroup`, pins that physical cgroup identity, moves the
daemon into a `launcher-control` child, and enables `cpu`, `memory`, and `pids` on the
actual delegated service root. It then proves child creation/removal, exact limit
write/readback, blocked-probe membership, `cgroup.kill`, `populated 0`, and empty-child
removal. Stale `operation-*` and `probe-*` cgroups are killed and removed before health.

The checked-in systemd unit intentionally omits `MemoryDenyWriteExecute=true`: it would
be inherited by the sandbox and can break the fixed Node/V8 runtime despite not being
part of version-3 authority. The unit retains `NoNewPrivileges`, a strict host filesystem
view, private devices/tmp, empty capabilities, and AF_UNIX-only daemon networking. Those
unit restrictions harden the trusted launcher; they do not substitute for the operation
sandbox.

## Trusted configuration

Configuration version 1 is closed and contains trusted deployment paths only:

```json
{
  "version": 1,
  "socketPath": "/run/ticket-system-process/launcher/launcher.sock",
  "stateRoot": "/var/lib/ticket-system/process-launcher",
  "allowedClientUid": 62002,
  "launcherServiceUid": 62004,
  "materializerServiceUid": 62001,
  "runtimeClientGid": 62002,
  "handoffGid": 62005,
  "trustedRootfsOwnerUid": 0,
  "materializerSocketPath": "/run/ticket-system-process/materializer/materializer.sock",
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
  "seccompPolicyPath": "/etc/ticket-system/process-seccomp-v1.json",
  "seccompPolicySha256": "lowercase-sha256",
  "containmentProbe": {
    "rootfsId": "node-24-fedora-runtime-v1",
    "executablePath": "/usr/bin/process-containment-probe",
    "executableSha256": "lowercase-sha256",
    "format": "elf"
  },
  "protectedHostPaths": {
    "runtimeData": ["/var/lib/ticket-system/runtime"],
    "materializerState": ["/var/lib/ticket-system/process-inputs"],
    "workspaces": ["/srv/ticket-system/workspace"]
  }
}
```

Rootfs, manifest, Bubblewrap, seccomp, state, and socket paths are never request fields.
The complete rootfs and every regular-file hash are revalidated before a launch.
Configured executable authority is a rootfs-internal ELF path and SHA-256; scripts and
shebangs are rejected.

The launcher and materializer retain kernel `flock` leases for their service lifetime.
Socket directories are pre-provisioned for the runtime group. Private launcher state and
sealed snapshot ancestors are pre-provisioned for the handoff group. The services create
only their socket entries and descriptor-relative internal state.

## Materializer descriptor handoff

Node never translates a workspace snapshot ID into a path. `launch` sends the exact
snapshot ownership tuple to the materializer's launcher-only `acquireSnapshot` operation:

- snapshot, run, ticket, operation, and canonical operation identities;
- policy-snapshot and filesystem-policy hashes;
- materializer generation;
- manifest hash, file count, and total bytes.

The materializer authenticates the launcher UID separately, revalidates its durable
registry, sealed tree, and canonical manifest, then sends exactly two read-only
descriptors with `SCM_RIGHTS`: the normalized tree and manifest. It returns no host path.
The runtime UID cannot invoke `acquireSnapshot`; the launcher UID cannot invoke
`materialize`. The launcher verifies descriptor type, ownership, manifest hash, counts,
bytes, modes, and exact tree contents again after receipt.

The distinct handoff group makes the opaque sealed ancestors traversable by the launcher
through Bubblewrap's descriptor-backed mount while remaining non-traversable by the
runtime principal. The descriptors exist only for the bounded launch operation.

## Protocol and launch authority

Messages are closed version-1 JSON frames prefixed by a four-byte big-endian length and
bounded at 2,097,152 bytes. `SO_PEERCRED` must equal the configured runtime UID. The
pre-authentication refusal uses `requestId: null` only with
`PROCESS_LAUNCHER_CLIENT_UNAUTHORIZED`. The service sends that fixed refusal, then drains
one bounded frame without parsing it so an unread Unix-stream request cannot replace the
typed response with `EPIPE`.

`launch` accepts exactly:

```json
{
  "launchPlan": { "version": 1, "launchPlanHash": "lowercase-sha256" },
  "containmentGenerationId": "sandbox-containment-v1-lowercase-sha256"
}
```

The nested plan is the complete private launch-plan contract. Both Rust and Node
recompute its canonical hash and operation identity. The service independently validates
run/ticket IDs, phase, target/profile, policy hash, rootfs and ELF identities, workspace
ownership, filesystem policy, environment, all limits, fixed execution policy, and the
exact unexpired containment projection. Expanded or extra authority is rejected.

`getOperation` and `cancelOperation` accept exactly:

```json
{"operationIdentity":"process-operation:lowercase-sha256"}
```

Tranche 2A3 keeps only in-memory private operation state. Exact terminal replay returns
the same bounded result. It does not claim durable execution idempotency or restart
recovery; those belong to 2B.

## Pre-execution barrier and Bubblewrap plan

Wall time starts before workspace/rootfs validation and sandbox construction. For each
operation the launcher:

```text
validates the active generation and launch plan
→ revalidates rootfs and executable
→ acquires and verifies sealed workspace descriptors
→ creates the operation cgroup
→ writes and reads back cpu.max, memory.max, memory.swap.max, pids.max
→ creates stdin/stdout/stderr/status/seccomp/construction descriptors
→ forks a blocked copy of the trusted launcher image
→ moves that blocked PID into the operation cgroup
→ verifies it is the only member and still the launcher image
→ releases one construction-gate byte
→ fexecve's the pinned Bubblewrap descriptor with an argument array
```

All source descriptors are first duplicated above the fixed authority range, preventing
multi-launch descriptor-number collisions. The parent drops those temporary duplicates
immediately after `fork`. No untrusted instruction executes before limits and membership
are active.

The fixed Bubblewrap argument plan is:

```text
--unshare-user --unshare-ipc --unshare-pid --unshare-net
--unshare-uts --unshare-cgroup
--disable-userns --assert-userns-disabled
--die-with-parent --new-session --clearenv --cap-drop ALL
--ro-bind-fd <pinned-rootfs-fd> /
--ro-bind-fd <sealed-workspace-fd> /workspace
--proc /proc
--dev /dev
--size <maxTempBytes> --tmpfs /tmp
--chdir /workspace[/trusted-relative-working-directory]
--seccomp <sealed-policy-fd>
--json-status-fd <status-fd>
--setenv LANG C.UTF-8
--setenv LC_ALL C.UTF-8
--setenv TMPDIR /tmp
[exact snapshotted environment entries]
--
<rootfs-internal executable path>
[exact snapshotted arguments]
```

There is no host `/`, `/usr`, `/lib*`, `/bin`, `/home`, `/root`, `/run`, host `/tmp`,
database socket, runtime state, materializer state, artifact path, or other workspace.
Rootfs and workspace are read-only. `/tmp` is a private size-bounded tmpfs. `/proc`
belongs to the private PID namespace; `/dev` is Bubblewrap's private minimal device view.

## Network, seccomp, environment, and streams

A fresh network namespace has no veth or inherited sockets. The mount plan supplies no
host socket or DNS path. The canonical pinned seccomp policy returns `EPERM` for
`socket(2)` and privileged authority syscalls including mount/remount, namespace
creation, ptrace, kernel modules, BPF, perf events, keyrings, process-memory access,
open-by-handle, userfaultfd, and io_uring setup. `socketpair` remains available for
operation-local IPC. Bubblewrap applies `no_new_privs` and drops all capabilities.

The active probe verifies different mount, PID, network, IPC, UTS, and cgroup namespace
inodes and observes `Seccomp: 2` in a live sandbox child. It tests IPv4, IPv6, loopback,
filesystem and abstract Unix access, Netlink, host paths, host processes, privileged
syscalls, inherited descriptors, and exact environment.

The child environment is rebuilt from the deterministic `LANG`, `LC_ALL`, and `TMPDIR`
values plus the exact profile environment. Ambient `PATH`, `HOME`, `DATABASE_URL`,
provider credentials, `NODE_OPTIONS`, `LD_PRELOAD`, `LD_LIBRARY_PATH`, agent sockets,
D-Bus, and runtime variables are absent. Stdin is `/dev/null`; there is no PTY and no
detached process. Stdout and stderr are independent raw-byte pipes.

## Resources, output, time, and tree ownership

The operation cgroup is authoritative for the entire tree, regardless of fork,
double-fork, process group, or session changes:

- `pids.max` enforces `maxProcesses` as kernel tasks, including threads and sandbox init;
- `memory.max` and `memory.swap.max=0` enforce memory, attributed only from cgroup OOM
  counters;
- `cpu.max` enforces the snapshotted rate and records throttling, but throttling is not a
  terminal resource cause;
- `RLIMIT_NOFILE` and `RLIMIT_FSIZE` enforce open-file and file-size ceilings;
- `RLIMIT_CORE=0` disables core dumps;
- private tmpfs capacity enforces `maxTempBytes`.

`maxOutputBytes` is the combined raw stdout-plus-stderr ceiling. Separate streaming
threads maintain byte counts and SHA-256 hashes with fixed-size buffers. Production
results retain no output content. Crossing the combined boundary sets a host-owned
decision and immediately kills the whole cgroup. The launcher continues draining until
EOF, waits for `populated 0`, and removes the cgroup.

Timeout uses a monotonic clock and includes setup. Timeout, cancellation, output limit,
observed `pids.events max`, and observed memory OOM all use `cgroup.kill`. The launcher
waits for the top-level pidfd, verifies the cgroup is empty, and then classifies.
`cpu` is not a terminal resource cause. `file_size` is attributed only to direct
`SIGXFSZ`; open-file and temporary-storage failures are not guessed from application
errors.

The private terminal result contains only identities, timestamps/duration, exit/signal,
stream counts/hashes, truthful cause fields, CPU-throttle count, and the deterministic
launcher environment. No unbounded output is returned.

On launcher death, the blocked child/top-level Bubblewrap receives a parent-death signal,
Bubblewrap uses `--die-with-parent`, and the private PID namespace tears down remaining
descendants. The systemd unit owns the full delegated service cgroup with
`KillMode=control-group`. Startup kills and removes stale operation cgroups before active
health. Durable lifecycle reconciliation remains a 2B concern.

## Active containment generation

Health is published only after the cgroup delegation probe and the fixed adversarial
fixture set pass:

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

The generation binds launcher, Bubblewrap, seccomp, rootfs registry, materializer,
delegated cgroup physical identity/controllers, mount-plan version, and complete active
probe observations. It is time-bounded. An unavailable, expired, or mismatched primitive
has no fallback.

The active probe executes fixed launcher-owned modes for mount/network/seccomp/environment
inspection, output flood, timeout, double-fork descendants, processes, threads, memory,
file size, temporary storage, open files, CPU throttling, and the fixed Node compatibility
operation `/usr/bin/node --check /workspace/server.js`. Child text is not the sole proof:
the host observes namespace identities, seccomp mode, cgroup counters, limits, tmpfs
capacity, exit status, hashes, and `populated 0`.

The mandatory process-enabled release gate is:

```sh
node scripts/process-launcher-foundation-cross-uid-test.js
```

It requires Linux, Bubblewrap, a systemd user manager, cgroup-v2 delegation, user/mount/
PID/network namespaces, seccomp, subordinate UID mappings, and distinct mapped runtime,
materializer, launcher, trusted-rootfs, and unauthorized identities. It proves
cross-principal descriptor authority, the fixed Node profile, replay, cancellation,
launcher crash, descendant death, stale-cgroup cleanup, and restart health.

## Stable failures

In addition to the 2A2 rootfs/backend/prerequisite failures, active launch uses:

- `PROCESS_CONTAINMENT_UNAVAILABLE`
- `PROCESS_CONTAINMENT_GENERATION_MISMATCH`
- `PROCESS_CONTAINMENT_EXPIRED`
- `PROCESS_LAUNCH_PLAN_INVALID`
- `PROCESS_SNAPSHOT_DESCRIPTOR_UNAVAILABLE`
- `PROCESS_SNAPSHOT_DESCRIPTOR_INVALID`
- `PROCESS_SNAPSHOT_PRINCIPAL_UNAUTHORIZED`
- `PROCESS_CGROUP_DELEGATION_UNAVAILABLE`
- `PROCESS_CGROUP_CONTROLLER_UNAVAILABLE`
- `PROCESS_CGROUP_LIMIT_UNAVAILABLE`
- `PROCESS_CGROUP_MEMBERSHIP_FAILED`
- `PROCESS_CGROUP_TERMINATION_FAILED`
- `PROCESS_NAMESPACE_UNAVAILABLE`
- `PROCESS_MOUNT_LAYOUT_INVALID`
- `PROCESS_NETWORK_ISOLATION_UNAVAILABLE`
- `PROCESS_SECCOMP_INSTALLATION_FAILED`
- `PROCESS_ENVIRONMENT_INVALID`
- `PROCESS_FAILED_TO_START`
- `PROCESS_OUTPUT_LIMIT_EXCEEDED`
- `PROCESS_WALL_TIME_EXCEEDED`
- `PROCESS_RESOURCE_LIMIT_EXCEEDED`
- `PROCESS_OPERATION_NOT_FOUND`
- `PROCESS_OPERATION_ALREADY_ACTIVE`
- `PROCESS_OPERATION_TERMINATION_FAILED`

No failure falls back to an unsandboxed launch.

## Remaining boundary

Tranche 2B may connect already-authorized dispatch to a private healthy launcher
generation and add durable start/terminal evidence, bounded output artifacts,
PostgreSQL execution idempotency, cancellation/recovery, and completion integration.
Until then the active descriptor remains private, runtime capability remains null, and
model execution remains denied.
