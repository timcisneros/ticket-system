# Process-execution GA runbook

This runbook governs the trusted materializer, launcher, runtime integration,
PostgreSQL lifecycle authority, and immutable output artifacts. It grants no
shell, PID, signal, path, or containment controls.

## Installation and readiness

1. Build from a clean checkout with locked dependencies:

   ```sh
   pnpm install --frozen-lockfile
   npm run build:materializer
   npm run build:launcher-foundation
   ```

2. Install the fixed binaries under `/usr/libexec/ticket-system`, install the
   checked-in units/tmpfiles configuration, and provision the dedicated
   `ticket-system-runtime`, `ticket-system-materializer`, and
   `ticket-system-launcher` users and the checked-in groups.
3. Install root-owned launcher/materializer configuration, rootfs manifests,
   rootfs trees, and seccomp policy. Install `/etc/ticket-system/ticket-system.env`
   as root-owned mode `0640`. Never put credentials in the release manifest.
4. Run tmpfiles and start both native services, then the runtime. New admission
   starts disabled.
5. Run:

   ```sh
   npm run release:db-preflight
   npm run release:ga-check
   ```

The runtime status API's `processExecutionReleaseHealth` must be `disabled` with
no integrity alerts before canary enablement. `blocked` means repair the exact
compatibility/integrity issue. `degraded_read_only` preserves inspection,
recovery, finalization, and cancellation but refuses new admission.

## Staged rollout

Use one existing target/profile grant as the canary boundary. First bind the
validated committed generation:

```sh
npm run release:admission -- --enable --actor release-operator --reason canary
```

Submit one bounded authorized syntax-check run through the normal ticket API.
Verify its process receipt, stdout/stderr artifact hashes, completion decision,
and terminal supervision. Submit one bounded long-running fixture and cancel it
through the normal run stop action; verify confirmed-empty process-tree state.
Restart the launcher during the dedicated recovery fixture and verify no replay.
Only then broaden grants already present in the trusted catalog. Model text is
never rollout evidence.

On a failed canary, immediately disable new admission:

```sh
npm run release:admission -- --disable --actor release-operator --reason canary-failed
```

Disabling is the operational kill switch. It is PostgreSQL-durable and audited.
It creates no cancellation by itself and does not alter admitted snapshots,
launcher ownership, observation, recovery, output finalization, receipts,
completion decisions, or ticket projection.

## Upgrade and rollback

The exact upgrade order is:

```text
paired database/artifact backup
→ disable admission
→ drain or cancel active work
→ prove no unsafe process/capacity/lease ownership
→ stop runtime generation
→ migration preflight and migration
→ install matching application and native components
→ validate owners, modes, sockets, and cgroup delegation
→ start with admission disabled
→ validate readiness
→ canary
→ enable admission
```

Record the release manifest hash and backup identity before migration. Never
automatically restore or run reverse SQL. If the prior application supports the
current schema according to the compatibility matrix, binary rollback is allowed
after owned work settles. Otherwise stop the generation and restore the paired
PostgreSQL and artifact backup.

Production backup uses `pg_dump` in PostgreSQL custom format and a
same-logical-point archive of `/var/lib/ticket-system/artifacts`; the release
environment must provide compatible `pg_dump` and `pg_restore` clients. The
mandatory regression restores the archive into a separate schema without
reseeding, restores artifacts under a different root, and verifies immutable
operation, receipt, budget, artifact, consequence, completion-decision,
release-state, and migration-identity hashes. Leave admission disabled after a
production restore, reconcile, and run the canary. A restored known operation
is never relaunched, and unavailable backup tools fail with
`PROCESS_RELEASE_BACKUP_TOOL_UNAVAILABLE`.

## Operational incidents

- Capacity exhausted: keep admission disabled if needed, finish durable
  finalization, then compact only acknowledged terminal launcher records whose
  receipt, evidence, artifacts, completion decision, and run terminalization are
  durable with `npm run release:compact-launcher`. Active/finalizing or
  unacknowledged records cannot compact.
- Missing receipt: leave supervision `finalizing`; run existing startup
  reconciliation. Do not repair from a GET.
- Stuck finalization, evidence failure, or artifact failure: use exact release
  health category and durable operation identity; preserve bytes and evidence.
- Containment failure: disable admission and repair native generation/readiness.
  There is no degraded uncontained launch.
- Launcher restart: systemd `KillMode=control-group` owns descendants; restart
  reconciliation terminalizes interrupted accepted authority and never relaunches
  it.
- Runtime restart: leave native ownership intact and use existing startup
  reconciliation.
- Stuck process: use the authorized run-level cancellation action. Never signal a
  PID or manipulate a cgroup directly.

The bounded diagnostic bundle is the authorized runtime status, exact run state,
operation receipt/evidence/consequence projections, release manifest hash, and
native service status. It excludes raw output, credentials, host paths, PIDs,
cgroup paths, sockets, and private launch plans.

Verify no descendants remain through the existing launcher terminal result and
`confirmed_empty` supervision fact; deployment tests separately prove service
`KillMode=control-group` and stale-cgroup cleanup.

## Retention and packaging

Launcher compaction retains immutable operation identity, launch-authority hash,
terminal-result hash, acknowledgement authority, durable-finalization hash,
timestamp, version, and record hash. Compact tombstones are restart-durable,
idempotent, conflict-checking, and never time-only deletion authority. Full
records and compact tombstones have separate hard capacities.

Abandoned process artifact `.tmp` files older than one hour are removed at
startup using the trusted artifact root. Published artifacts remain retained
indefinitely by default; expiry is disabled until a reference-aware deletion
contract exists. Missing bytes never mean an empty stream.

Generate release evidence and a deterministic allowlisted tar inventory only
from committed source:

```sh
pnpm install --frozen-lockfile
npm run release:licenses
PROCESS_RELEASE_CHECKPOINT_REFERENCE=checkpoint:release:passed npm run release:manifest
npm run release:package -- --output-directory /tmp/ticket-system-release
```

The tar inventory, ownership normalization, file timestamps, and checksums are
deterministic. The archive includes the project MIT license, contribution terms,
and the generated third-party notice bundle tied to the exact Node and Cargo
lockfiles. Regenerate the bundle after an intentional dependency update with
`npm run release:licenses:generate`; a stale or incomplete notice bundle fails
the release checkpoint. Native bit identity additionally depends on the recorded Rust
toolchain and platform; the release does not claim cross-toolchain bit-identical
binaries.
