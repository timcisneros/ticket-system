# Deployment Contract

Canonical deployment and operations authority for the ticket system, frozen by the P6
deployment/operations design freeze (canonical record: `ARCHITECTURAL_DECISIONS_PENDING.md`,
"P6 — DEPLOYMENT / OPERATIONS — semantic design freeze"). This document owns deployment
semantics only. It carries design authority; per that register record it does not by itself
authorize P6-S2 or P6-S3 implementation.

Specialized owners remain canonical for their subsystems and are referenced, not copied:

- PostgreSQL runtime authority, concurrency, and durability → `POSTGRES_CUTOVER.md`
- Process-execution release installation, enablement, backup, and incidents →
  `PROCESS_EXECUTION_GA_RUNBOOK.md`
- Read-only operational surfaces → `OPERATIONAL_TRANSPARENCY.md`
- Telemetry semantic definitions → `OPERATIONAL_TELEMETRY.md`
- Local environment setup and first run → `SETUP_AND_FIRST_RUN.md`
- Deliberately unsupported capabilities → `KNOWN_LIMITATIONS.md`
- Roadmap, phase sequencing, and design authority → `ARCHITECTURAL_DECISIONS_PENDING.md`

## 1. Purpose

Make the already-governed product operationally deployable while preserving canonical product
authority. P6 is an operational prerequisite: not a capability stage, not a
product-semantics redesign, not a bundle of production-infrastructure features, not P7, not
Browser Phase 3. Roadmap registration never grants implementation authority; each slice
requires its own authority under the P6 register record.

## 2. Supported deployment topology

**Single-host, multi-process hosted deployment.**

- Structured authority is process-independent and PostgreSQL-owned: tickets, runs, attempts,
  leases, lifecycle transitions, events, replay, receipts, sessions, catalogs, and runtime
  policy (`POSTGRES_CUTOVER.md`).
- Sessions are PostgreSQL-backed and shareable across application processes.
- Run admission is deployment-wide and PostgreSQL-owned; multiple application processes may
  contend for work through the existing claim/lease mechanisms.
- Effect storage may remain host-local: `WORKSPACE_ROOT`, `ARTIFACT_ROOT`, browser artifacts,
  and process artifacts are effect boundaries, not structured product authority.
- Application processes are **not** "stateless": they hold host-local effect state and
  in-process advisory execution state. Authority is process-independent; effects are
  host-bound.

## 3. Unsupported topology

Multi-host horizontally distributed execution is **not** claimed by baseline P6.

Reason: host-local effect storage remains part of the execution boundary. Two hosts cannot
share workspace, artifact, browser, or process effects through the current design. A future
shared workspace/blob/artifact design is separately demand-gated (§11) and must preserve
Ticket/Run/PostgreSQL authority without becoming alternate structured authority.

P6 preserves architecture that does not foreclose later multi-host execution, but claims no
such capability now.

## 4. Scheduler and recovery model

- No leader election is required by the intended architecture.
- Each application process may run its normal runtime scheduler.
- PostgreSQL is the deployment coordination boundary: run claims use the existing database
  fencing (the admission transaction's `FOR UPDATE SKIP LOCKED` claim); leases define
  temporary execution ownership; expired leases permit canonical recovery; recovery
  continues/reconciles the **same** Run and attempt; deterministic identities prevent
  duplicate logical effects.
- Process-local caches, sets, and scan cursors are advisory only — never authority.
- No operational leader-election authority is introduced.

**Proof level.** Store-level contention, admission, and recovery semantics have existing
deterministic evidence. Full-process multi-scheduler competition, crash, and takeover are
the **intended supported topology conditional on P6-S3 process-level verification** — they
are not claimed proven before that evidence exists.

## 5. Operational authority boundary

**Operational convenience does not create product authority.**

Every operational mechanism is exactly one of:

1. read-only;
2. routed through an existing canonical product seam;
3. governed by an existing explicit authority system (for example, the migration-execution
   authorization record).

Operational tooling MUST NOT:

- write Ticket state directly;
- write Run lifecycle state directly;
- manufacture attempts;
- bypass admission;
- bypass completion authority;
- alter immutable admitted snapshots;
- resurrect stale Runs manually;
- rewrite durable evidence;
- widen capability;
- bypass migration authorization.

Restart, drain, recovery, backup, restore, diagnostics, and deployment procedures derive
their authority from existing canonical systems.

## 6. Health semantics

Three distinct concepts. Current endpoint behavior that conflates them is a P6-S2
correction target, not doctrine.

### 6.1 Liveness

The process exists and can answer.

- No PostgreSQL probe, no migration probe, no downstream dependency requirement.
- Liveness must not kill or restart an otherwise functioning process merely because an
  external dependency is unavailable.

### 6.2 Readiness

This process may safely receive normal application traffic. Baseline readiness requires:

- PostgreSQL reachable;
- canonical migration ledger compatible (no missing/pending migrations, no unknown future
  migrations);
- canonical migration checksum identities valid;
- no evidence-persistence fail-closed latch;
- required startup configuration valid;
- required local effect roots usable for work the process may receive.

The exact implementation belongs to P6-S2.

### 6.3 Capacity / backpressure

Capacity is **not** readiness. Mutation-admission pressure, deployment-wide `maxActiveRuns`,
provider concurrency pressure, and similar work-capacity conditions are surfaced as
operational/application capacity status — never as a reason for a load balancer to mark an
otherwise healthy process unready. The current 503-backpressure-as-readiness endpoint
behavior is expressly not preserved as doctrine; it is a P6-S2 correction target.

## 7. PostgreSQL readiness probe

Baseline P6-S2 implementation design:

- Reuse the canonical persistence owner: `PostgresRuntimeStore.getMigrationStatus()` (or its
  current canonical equivalent) supplies reachability, pending/missing migrations, unknown
  future migrations, checksum identity, and partial/incompatible migration state. Do not
  duplicate migration enumeration or checksum logic.
- Cadence: one read-only probe per readiness request, unless implementation evidence
  demonstrates a material performance problem. A future optimization may serve a periodically
  refreshed value only with explicitly bounded staleness.
- Forbidden: mutation; indefinite cached success; startup-only health truth after startup;
  an unhandled 500 response on ordinary dependency outage.
- Failure shape: designed, sanitized, bounded, `ready: false`, HTTP 503 readiness response.
- Liveness remains dependency-free.

## 8. Configuration ownership

One executable canonical configuration registry is the machine-readable owner of supported
environment variables and drives or validates `.env.example`, `dev:doctor`, setup guidance,
and documentation parity. For each supported setting it defines at least:

- variable name;
- required vs optional;
- validation;
- development default;
- production behavior/default;
- secret classification.

It never exposes secret values. The registry replaces scattered hand-maintained ownership; no
second prose master list is created. Detailed implementation belongs to P6-S2.

## 9. Migration and bootstrap doctrine

T10 migration execution authority is preserved exactly (owners:
`persistence/postgres/migration-authority.js` and
`config/migration-execution-authorization.json`). Five states:

**A. Fresh non-disposable bootstrap** (empty production schema). Requires an exact
transition-specific `AUTHORIZED` record: exact observed pre-state, exact ordered pending
migration set with source hashes, exact target identity, and the repository/publication
authority T10 requires. Then execute through the existing canonical migration command,
verify the resulting state, and retire the authorization back to `NOT_AUTHORIZED`.

**B. Ordinary upgrade** (pending migrations on an initialized schema). Same model: exact
pre-state, exact pending set, exact source hashes, exact target, exact published authority,
transition-specific authorization, execute, verify, retire.

**C. Fully current schema.** No authorization required. Migration execution is a
mutation-free no-op after canonical identity validation.

**D. Unauthorized pending transition.** Refused BEFORE any mutation. Operator intent alone
is insufficient.

**E. Explicit disposable test schema.** May use the repository's existing code-declared
disposable-migration contract. Disposability is never inferred from database name, schema
prefix, `TEST_DATABASE_URL`, environment kind, localhost identity, or a missing schema.

Prohibited: permanent bootstrap authorization; wildcard authorization; environment bypass;
CLI force flag; "first startup automatically migrates"; authorization by convention.

Migration 044 remains `NOT_AUTHORIZED`. Nothing in P6 authorizes or executes it.

## 10. Deploy / migrate / rollback ordering

The binary accepts only a schema exactly compatible with its repository migration identity.
Baseline P6 therefore does **not** support mixed-version deployment across a migration
boundary.

- Never assume an older binary can run against a newly migrated schema.
- Never assume a newer binary can run against an older schema.
- Rollback to a pre-migration binary requires the matching pre-migration database state.
- Otherwise prefer roll-forward to software matching the current schema.
- If restoration is required, restore the paired durable state needed to preserve
  authority/evidence (paired database and artifact state, per the existing runbook
  precedent).
- Do not invent reverse SQL/down migrations; do not auto-revert migrations.

Deployment ordering follows the existing runbook precedent: paired backup → disable/drain
work → migration under exact authorization → matching binary → readiness validation →
resume work. Zero-downtime migration orchestration remains demand-gated and is not required
for P6 baseline closure.

## 11. Storage boundary

- **Structured authority:** PostgreSQL.
- **Effect storage:** host-local filesystem boundaries — workspace, artifacts, browser
  artifacts, process artifacts. These MUST NOT become alternate structured authority.
- **Baseline closure:** single-host multi-process deployment may close P6 without
  implementing shared storage.
- **Deferred:** multi-host execution requires a separately designed shared
  target/blob/storage boundary that preserves Ticket/Run/PostgreSQL authority. That design
  is demand-gated.

## 12. Observability and operator recourse

Minimal doctrine, not a dashboard project. Reuse the existing surfaces: run logs,
system/diagnostic logs, the event journal, `/ops` and the operational summary, the
health/readiness endpoints, release/checkpoint evidence, and the existing telemetry
contracts (`OPERATIONAL_TRANSPARENCY.md`, `OPERATIONAL_TELEMETRY.md`).

P6 baseline requires:

- honest readiness;
- an app-level deployment/recovery runbook;
- operator procedures for the failure matrix (§13);
- references to existing diagnosis surfaces.

No external observability service, dashboard stack, metrics platform, or logging vendor is a
P6 closure requirement.

## 13. Failure and recovery matrix

Current proof state, stated honestly — nothing here upgrades architectural inference to
"proven safe":

| Failure | Proof state |
|---|---|
| Application process crash | Architecture says recoverable; needs P6-S3 full-process proof |
| Scheduler crash | Same class as application-process crash (the scheduler is in-process); needs P6-S3 proof |
| Worker crash | No separate worker tier in the baseline; in-process task failure/recovery uses Run lease/recovery authority; needs process proof where appropriate |
| PostgreSQL outage | Fail-closed mutation posture already exists; health/readiness signaling correction belongs to P6-S2; full-process outage behavior belongs to P6-S3 |
| PostgreSQL restart | Architecture expects recovery; P6-S3 proves process behavior |
| Lease expiration | Store-level semantics proven; full-process takeover belongs to P6-S3 |
| Duplicate schedulers | Store-level contention proven; full-process topology conditional on P6-S3 |
| Deployment restart | Startup recovery and bounded drain mechanisms exist; P6-S3 proves deployment behavior |
| Configuration failure | Fail-closed startup |
| Missing required secret | Fail-closed startup |
| Migration mismatch | Fail-closed startup; already canonical |
| Workspace/artifact failure | Effect failure must remain truthful; shared multi-host backend remains deferred |

## 14. Demand-gated exclusions

P6 baseline does NOT implement or pre-authorize:

- multi-tenancy;
- row-level tenant isolation;
- managed secret service;
- backup automation;
- point-in-time recovery;
- event partitioning/retention architecture;
- read replicas;
- zero-downtime migration orchestration;
- shared workspace/blob service;
- arbitrary multi-host execution;
- cloud-provider selection;
- Kubernetes;
- Terraform;
- P7 integrations;
- Browser Phase 3;
- Ticket/Run/attempt semantic changes;
- P2/P3/P4/P5 reopening.

Each remains a separate registered design if demand materializes.

## 15. Closure and deferral boundary

P6 closes only when repository bytes and deterministic verification establish every item of
the closure definition in the P6 register record: supported and unsupported topology
explicit; operational authority unable to bypass product authority; honest
liveness/readiness/capacity semantics; parity-tested canonical configuration ownership;
T10-preserving bootstrap/upgrade/rollback procedures; deterministically verified
process-level scheduler/crash/restart behavior; operator deployment/recovery recourse;
explicit demand-gated limitations; one independent combined P6 closure review; and one full
canonical checkpoint at P6 closure.
