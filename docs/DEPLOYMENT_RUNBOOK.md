# Deployment Runbook

Canonical single-host multi-process operator procedure (P6-S3). Authority:
P6 design freeze (`ARCHITECTURAL_DECISIONS_PENDING.md`, "P6 — DEPLOYMENT /
OPERATIONS") and `docs/DEPLOYMENT_CONTRACT.md` §2/§4/§6/§9/§13. This runbook
derives every procedure from existing canonical systems; it adds no operational
authority, no write surface, and no migration shortcut.

Deployment model (frozen): one host, multiple application processes, PostgreSQL
as the only structured authority, host-local effect roots. Claims, leases,
attempts, evidence, sessions, catalogs, and runtime policy are process-agnostic.
There is NO leader process and NO in-memory continuity between processes: a run
claimed once stays owned through its lease. Process-level behavior is proven by
`scripts/p6-s3-hosted-recovery-postgres-test.js` (part of the release
checkpoint); its scenario labels are cited below as evidence anchors.

## 0. What the processes are

- One application process = one `node server.js` (see the repository README for
  the packaged start command for each mode). One HTTP listener per process
  (`PORT`); every process runs its own in-process scheduler; work admission and
  claim/lease fencing are PostgreSQL-side, so any process can claim any pending
  work.
- Multiple processes on the SAME host must share the SAME operational
  `DATABASE_URL` and `POSTGRES_SCHEMA`, and the SAME host-local effect roots
  (`WORKSPACE_ROOT`, `ARTIFACT_ROOT`). Running them is what the release
  checkpoint's `MULTIPROCESS-A` scenarios prove: claims are mutually exclusive,
  the deployment-wide `maxActiveRuns` seat is honored across processes, and a
  frozen or dead process loses no authority the surviving ones cannot take
  through PostgreSQL.
- Two processes may run simultaneously on one host; more still work, but each
  adds a full server (scheduler + HTTP surface). Capacity/backpressure is
  process-local; the active-run seat is deployment-wide.
- None of this is multi-host: two hosts cannot share workspace/artifact/browser
  effects (`DEPLOYMENT_CONTRACT.md` §3/§11) — do not point hosts at one
  workspace root and do not claim multi-host support.

## 1. Start

Prerequisites (from `docs/SETUP_AND_FIRST_RUN.md`): PostgreSQL reachable at the
configured operational `DATABASE_URL` (never the disposable development
database for production containment), `SESSION_SECRET` valid per the canonical
environment registry (`runtime/environment-config-registry.js`), admin
bootstrap only on first initialization, and a configured agent/provider for
product work.

1. `pnpm dev:doctor` (same as `node --env-file-if-exists=.env.local
   scripts/dev-doctor.js`) — read-only preflight. It
   validates the configuration registry, the disposable-development posture,
   and renders one informational row for the CONFIGURED operational target
   (identity only, never contacted). Resolve every `fail` row before starting;
   an invalid configuration fails the server startup itself (fail-closed boot).
2. Migration posture (read-only procedure, `T10`-safe):
   - `pnpm db:migrate` is the canonical migration command. On a fully-current
     schema it prints `PostgreSQL schema <schema> is current` — a no-op (no
     authorization needed, no mutation). On a pending-but-UNAUTHORIZED
     transition it REFUSES BEFORE ANY MUTATION
     (`MigrationExecutionAuthorityError`, `NOT_AUTHORIZED` in the record) —
     that refusal is the honest posture read. There is no force flag.
   - Equivalent read-only eye-level SQL (bounded, no mutation):
     `SELECT version FROM <schema>.schema_migrations ORDER BY version;` and
     `SELECT version, sha256 FROM <schema>.schema_migration_identities ORDER BY
     version;` — the columns must equal one-to-one with
     `persistence/postgres/migrations/` and the sha256 of each file. Any
     unknown row, missing row, or different digest = incompatible server
     (see §6).
3. Server configuration: each process needs `DATABASE_URL`, `POSTGRES_SCHEMA`,
   `SESSION_SECRET`, `PORT`, `WORKSPACE_ROOT`, `ARTIFACT_ROOT`; secrets are
   never logged (`no-tracked-provider-keys-test.js` guards them out of the
   repository). Optional process knobs: `RUN_LEASE_DURATION_MS` (lease length,
   default 180000), `SHUTDOWN_RUN_DRAIN_TIMEOUT_MS` (graceful drain bound,
   default 120000), `MUTATION_ADMISSION_MAX_OUTSTANDING` (process capacity),
   `RUNTIME_SCHEDULER_INTERVAL_MS`, `WORKFLOW_MAX_TRANSITIONS`/`_LOOP`/`_MUTATIONS`,
   plus the documented optional `SESSION_PURGE_*` settings.
4. Start N processes on the SAME host with the same posture (item 0 above).
   Stage them one at a time; each prints `Server running on
   http://localhost:<PORT>` when its listener bound.
5. Expected readiness after startup: `/health` returns HTTP 200 with
   `alive: true`, `ready: true`, `status: "ok"`, a `capacity` block, and NO
   `readiness` block. Startup performs read-only posture checks; it does NOT
   apply migrations, and it settles stale runs from PostgreSQL (see §3/§5).

## 2. Normal status (read-only surfaces only)

- Process alive (liveness): the process answers — `GET /health` or `GET
  /api/health` returning ANY designed payload (200 or bounded 503) proves
  liveness; connection refusal/timeout IS the liveness failure. Liveness never
  checks PostgreSQL, migrations, providers, or capacity.
- Process ready: `ready: true` in `/health`. A `ready: false` carries a
  sanitized `reason` (`postgres_unreachable`, `migrations_incompatible`,
  `configuration_invalid`, `effect_root_unusable`, `evidence_persistence_latched`,
  `starting`) plus a `readiness` fact block, and is HTTP 503 — designed,
  bounded, credential-free.
- Migration status: §1 item 2.
- Evidence latch: `/health` `status: "degraded"`,
  `reason: "evidence_persistence_latched"`; `/api/runtime/status`
  (authenticated, `ops:read`-gated) exposes the event-persistence provenance
  (first-failure channel, PostgreSQL code, run/ticket binding — bounded and
  read-only).
- Run/worker/lease state: `/api/runtime/status` (authenticated) lists
  pending/running runs with `lease`, `leaseExpiresAt`, `lastHeartbeatAt`,
  attempt positions, and the process-execution release health. The event
  journal (`/event-journal`, `/api/event-journal`) exposes claim events
  (`run.lease_acquired`, `run.recovery_claimed`, `run.resumed`, capacity,
  scheduler refusals) with hashes — read-only.
- Capacity/backpressure: `capacity.mutationAdmission` in `/health` shows the
  PROCESS-local admission state (`outstanding`, `availableSlots`, `status`:
  `available`/`backpressured`, high-water marks). Capacity pressure is
  recoverable and NEVER makes the process unready (P6-S2 `CAPACITY-A/B`
  evidence; `MULTIPROCESS-A` shows the same distinction while blocked by a
  peer's deployment-wide seat). The deployment-wide seat is inferred from
  pending-but-claimed capacity evidence (`capacity.waiting`) in the event
  journal, not from readiness.
- Operational door: `/ops` and `/api/ops/summary` — read-only summary with
  warnings only; it owns no remediation controls.

## 3. Process crash

A process can die anywhere (SIGKILL, OOM, supervisor kill). What happens is
repository-defined (`CRASH-A`/`LEASE-A` evidence):

- Whatever its roles were (scheduler, executor), its live Run lease remains
  valid (expiry is PostgreSQL-side truth, `RUN_LEASE_DURATION_MS`). Until that
  lease expires NOTHING may take that work over — no other process will
  redispatch it, no duplicate attempt appears, and no peer records any claim.
  Under this hold-off the deployment reports honestly: the run keeps the dead
  owner's lease; the deployment-wide seat stays consumed for it.
- At/after lease expiry, a SURVIVING process's scheduler claims recovery
  (`run.recovery_claimed`, mode `lease_expiry`, naming the previous owner) and
  continues the SAME Run and the SAME Ticket attempt. The recovered work is
  settled truthfully (completed with real verification, or failed/interrupted
  with a durable reason) — never silently marked successful, never converted
  into a new attempt.
- The operator procedure is: DO NOTHING until expiry; then observe. Do not
  manually replay, force-release, or re-run; there is no authority and no
  surface for it, and doing so through SQL would be operational direct state
  mutation. If the run is shown BLOCKED/FAILED after recovery, handle it as a
  normal terminal triage item through the existing operator surfaces
  (`/inbox`).
- Expect about `RUN_LEASE_DURATION_MS` from the last heartbeat before a peer
  may take over; contentions resolve through PostgreSQL. The event journal
  shows the exact recovery event and timing.

## 4. Whole-service restart

1. Stop every process with SIGTERM ('graceful drain', `DRAIN-A`): the process
   stops accepting new work immediately, lets already-started governed work
   settle, closes its HTTP surface, and exits with code 143. The drain is
   bounded (`SHUTDOWN_RUN_DRAIN_TIMEOUT_MS`); if it cannot finish inside the
   bound the process prints an explicit `Shutdown run-drain timeout` message
   and still stops — that message is the forced-stop boundary, NOT a claim of
   clean completion. Whatever remained active is recoverable by its lease
   rules (§3), and the exit is honest either way.
2. Confirm each process exited (143 or 130 on SIGINT).
3. Start processes again (§1 item 4). Startup performs
   `interruptStaleRunsOnStartup` — it reconciles stale runs (mode
   `process_restart`): runs whose lease already expired are recovered ONCE;
   consistent runs are not re-recovered by a second restart (`RESTART-A`
   evidence: idempotent, same attempt, no new attempt, no duplicate
   settlement).
4. Verify readiness per §2 ('expected: 200 ready') and migration posture per
   §1 item 2.

## 5. PostgreSQL outage

Behavior when the structured authority disappears (real outage evidence,
`PG-OUTAGE-A`):

- Fail closed automatically: every readiness observation turns into the designed
  `503 / unready / postgres_unreachable` failure while the outage lasts; liveness
  keeps answering (do NOT kill a process for being unready — liveness and
  readiness are separate, §2); schedulers keep ticking but claims fail and are
  logged, so nothing new is dispatched; mutation requests are REFUSED without
  durable state. There is no JSON fallback and no second authority.
- A severed idle pooled connection does not kill the process: the store owns a
  bounded observation of pool-level severances, so the outage is observable
  through the designed readiness shape instead of a process crash.
- Recovery condition: automatically as soon as PostgreSQL is reachable again —
  readiness becomes true per request (`/health`), without a restart and
  without operator action. The health evidence never latches from
  unreachability alone (`evidencePersistence: "healthy"` while unavailable).
  If a required evidence WRITE failed during the outage, see §7 (the evidence
  latch).
- The operator must NOT: bypass readiness with a load balancer rewrite, mutate
  PostgreSQL state "to fix", or restart healthy processes merely because their
  readiness was false during the outage. Read-only observation stays allowed.

## 6. Migration mismatch / incompatible ledger

Distinguish (state shapes — `MIGRATION-MISMATCH-A` evidence is deterministic):

- **Fully current** — `db:migrate` → `schema is current`; nothing to do.
- **Behind but exactly the authorized transition** — `db:migrate` applies
  under an exact T10 authorization record (exact observed pre-state, exact
  ordered pending set, exact target, exact published authority). Composing
  that authorization is a governed release procedure, not an operator action:
  its owners are `persistence/postgres/migration-authority.js`,
  `config/migration-execution-authorization.json`, and the
  `docs/POSTGRES_CUTOVER.md` precedent.
- **Behind and NOT authorized** — `db:migrate` REFUSES before any mutation,
  naming `NOT_AUTHORIZED`. Do not start changing versions against a mismatched
  ledger; resume only when the ledger is exactly compatible (§1 item 2).
- **Incompatible / drifted** (unknown future migrations, identity-digest
  drift, partial ledger) — the server REFUSES TO START (`missing required
  migration(s)…`, `unknown future migration(s)…`, `missing or changed
  migration identity…`; `MIGRATION-MISMATCH-A` evidence). There is NO
  down-migration, NO automatic migration, and NO operational authorization
  mutation; the recovery is to restore the paired application+schema state
  (§7 rollback).

T10 never weakens: neither this runbook nor any operator surface may clear,
compose, or bypass a migration authorization (§9 of the deployment contract).
Migration 044 remains `NOT_AUTHORIZED` and operationally unapplied unless a
separate T10 process authorizes it.

## 7. Evidence latch

When a REQUIRED evidence write fails while work is live (event append on a
real PostgreSQL boundary), the process latches fail-closed:

- `/health` → `status: "degraded"`, `reason: "evidence_persistence_latched"`,
  ready false; mutations are refused with HTTP 503
  `EVENT_PERSISTENCE_UNAVAILABLE` (no `Retry-After` — retrying is futile);
  BOTH schedulers in that process stop claiming (a latched process is
  demonstrably NOT a claimer); diagnostics stay reachable (`/api/runtime/status`
  shows the first-failure provenance and PostgreSQL classification; `/health`
  stays observable).
- The latch is process-wide and terminal for that process — it never
  self-heals, even after the underlying fault is repaired (`EVIDENCE-LATCH-A`).
  It is not persisted state: it exists only in the process that observed the
  failure. Other processes in the SAME deployment are unaffected and remain
  ready.
- Operator recovery: diagnose first (`/api/runtime/status` provenance — which
  channel failed, PostgreSQL code, retryability classification), confirm the
  PostgreSQL is reachable and current, then restart the affected process
  (§4 stop + start). A fresh process boots clean (no residue), reacclaims
  pending work, and continues honestly. NEVER clear the latch by writing
  health state directly; the repository has no such authority (the only
  in-process reset is the non-production `/admin/debug-reset` route).
- After a latched recovery, verify durable state: no work was lost (its lease
  recovery rules apply), no mutation was silently performed, and the event
  chain verifies.

## 8. Drain / shutdown

(`DRAIN-A` evidence; the mechanical owner for evidence drain is
`scripts/run-evidence-drain-test.js`.)

- `SIGTERM` / `SIGINT` = bounded graceful drain. New HTTP work closes; already-
  started governed work settles if it can; pending required evidence writes
  drain through their bounded rounds; the process reports exit 143 (or 130).
  An active run that cannot settle inside the bound → explicit timeout log —
  treat as forced-stop; the underlying run remains recoverable per §3. NEVER
  consider a timed-out shutdown as "clean" beyond what the process logged.
- During the drain window and after stop, new work cannot enter through that
  process. Another process will take over work ONLY after the stale-lease
  rules (§3) — a peer does NOT steal validly owned, non-stale work.
- Leases do NOT expire faster because you shut down: shutdown releases nothing
  but its own authority; the stale-lease clock is canonical PostgreSQL state.

## 9. Rollback (strict parity)

Frozen doctrine (`DEPLOYMENT_CONTRACT.md` §10): no mixed versions, no down
migration, no auto-revert.

- Rollback = restore compatible application/source state whose migration
  identity matches the CURRENT operational ledger, NOT "start the old binary
  to see". Check compatibility the same way the server does (§1 item 2:
  versions + sha256 identities). If the database has advanced incompatibly
  (past a migration the old code lacks, or forwards-only changes), the old
  application MUST NOT be started against it — it would refuse (that refusal
  is the contract) — and the restored pair must be reproduced from backups
  with BOTH application state and durable evidence paired (per the existing
  runbook precedent: paired database + artifact restoration).
- Schema advance without a paired artifact restore is a partial restore and
  must not be treated as a completed rollback.

## 10. Recovery verification (after any incident)

Run this list after ANY crash/outage/latch/restart event:

1. PostgreSQL authority consistent — event chain verifies (the release
   checkpoint's chain checks and `/api/event-journal` hash view); no
   unexplained unsettled or duplicate candidacy (one unsettled attempt per
   Ticket).
2. Migration ledger compatible — §1 item 2, current or exactly the authorized
   pending set, valid sha256 identities.
3. Each process answers (`/health` reachable); each process `ready: true`;
   every `capacity` block is included for its process, and observed
   backpressure is expectedly recoverable (not a readiness matter).
4. No process reports `evidence_persistence_latched` — if any does, follow §7
   restart (this is required recovery — do NOT just verify around it).
5. Effect roots usable — workspace and artifact files exist under the
   configured host-local roots and the process has read/write/traverse access
   (`effect_root_unusable` readiness reason is the designed negative signal).
6. Run/lease state — `/api/runtime/status`: no run is stuck "running" with a
   long-expired lease (if one is, wait for its recovery window; §3 explains
   exactly which peer takes it and when).
7. Release posture — the release checkpoint with a disposable
   `TEST_DATABASE_URL` remains the deterministic verification authority for
   this deployment surface (see `docs/SYSTEM_STATUS.md`).

## 11. Unsupported / never attempted here

- Multi-host execution, shared object/artifact storage, leader election,
  distributed consensus, service discovery, force-releasing leases, arbitrary
  run retries, clearing the evidence latch, or ANY migration bypass. These
  are frozen exclusions (`DEPLOYMENT_CONTRACT.md` §3/§11/§14; P6 stop
  conditions). An operator needing any of them must open a separate registered
  design first.
