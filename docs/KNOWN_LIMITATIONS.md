# Known Limitations

The PostgreSQL cutover is complete, but the product remains in development.

## Deployment work

- No production multi-tenant isolation or row-level tenant policy is claimed.
- Backup/restore automation, point-in-time recovery, replication, retention, partitioning, and
  zero-downtime migration orchestration are deployment responsibilities not implemented here.
- `WORKSPACE_ROOT` and browser artifacts are local filesystem targets. Multi-host execution needs an
  appropriate shared target/blob design without making those artifacts alternate state authority.
- Provider credentials and `SESSION_SECRET` remain operator-managed environment/configuration data.

## Cross-system effects

Database transactions cannot atomically commit filesystem, browser, model-provider, or external
connector effects. Prepared intent, stable operation keys, target idempotency, and reconciliation
reduce ambiguity, but external systems must participate in those contracts for end-to-end exactly
once behavior.

## Verification scope

Deterministic postconditions and regression coverage do not prove arbitrary task correctness.
Real-model latency and output quality remain provider observations unless runtime evidence identifies
a substrate failure. The local connector is a bounded contract fixture, not a production connector.

## Destructive development reset

The debug reset is disabled in production and is not disaster recovery. It clears ticket-linked
development state while preserving control catalogs. Production recovery must use database and
external-target operational procedures.
