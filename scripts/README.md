# Active Scripts

## Operator tools

- `oquery.js` — authenticated PostgreSQL-backed ticket/operator CLI.
- `op-session.js` — interactive helper using the server API.
- `codex-bootstrap.js` — print current runtime architecture and commands.
- `codex-trace.js` — fetch exact run state/events/map/log evidence through the API.
- `postgres-migrate.js` — apply ordered migrations using `DATABASE_URL` and `POSTGRES_SCHEMA`.

The operator tools do not read runtime JSON files. Collection exports traverse bounded cursor pages.

## Release verification

- `release-checkpoint.js` — complete deterministic gate; requires `TEST_DATABASE_URL`.
- `postgres-persistence-contract-test.js` — migration/repository structural contract.
- `postgres-persistence-integration-test.js` — isolated-schema lifecycle, transaction, integrity,
  concurrency, recovery, and repository integration coverage.
- `postgres-runtime-cutover-test.js` — application state, sessions, deployment/provider admission,
  reset, and cross-store visibility.
- `mutation-admission-contract-test.js` and `mutation-admission-scheduler-test.js` — recoverable
  process pressure and fail-closed evidence rules.
- `scheduler-observability-test.js` — scheduler behavior without a process-global execution cap.

Run all current release checks with:

```sh
TEST_DATABASE_URL='postgresql://...' npm run checkpoint:release
```

Many additional scripts are targeted regressions, experiments, benchmarks, or historical fixture
tools. Their presence does not make a JSON data directory a supported runtime backend. Retired
JSON repository and journal tests live under `ARCHIVE/legacy-json-runtime/`.
