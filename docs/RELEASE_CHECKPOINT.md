# Release Checkpoint

The release gate is one deterministic command backed by a disposable PostgreSQL database:

```sh
TEST_DATABASE_URL='postgresql://...' npm run checkpoint:release
```

The runner executes project-wide JavaScript syntax checks, focused business/runtime contracts,
mutation-admission and scheduler checks, the PostgreSQL repository contract, the real migration and
concurrency integration suite, the application-state/session/deployment-admission cutover test, and an authenticated PostgreSQL-native page-render regression.
It stops on the first failure and reports the exact number of completed checks.

CI provisions PostgreSQL 17, installs from `pnpm-lock.yaml`, and runs the same command. The tests
create isolated schemas and drop them on completion. Provider keys and network model calls are not
required.

This document defines the gate; it does not record a permanent passing result. Run the command for
current evidence before a release decision.
