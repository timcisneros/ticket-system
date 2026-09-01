# Operator Contract

## Roles

- **Operator**: creates tickets, reads logs, inspects results, runs appropriate verification, reports issues.
- **Developer agent**: edits the ticket-system application source as privileged product-development work.
- **Coding agent** (OpAgent-*): mutates only mounted workspace/user files inside `workspace-root` through the agent pipeline.

## Mutation Pipeline

All agent filesystem mutations must pass through:

```
ticket → agent run → recorded operations → replay/mutations
```

## External Side-Effect Boundary

OpAgent has no shell, process, webhook, plugin, SFTP, or arbitrary network
operation surface. The agent runtime currently has only:

- model provider calls, recorded in replay as provider requests/responses
- mounted workspace-provider operations inside `workspace-root`

If a future tool or provider can cause irreversible effects outside the
workspace provider, its attempted request must be recorded before execution
and its result/failure must be recorded separately. Until such a surface
exists, external side effects beyond model calls are absent, not merely
unmodeled.

## Allowed Surfaces

- `node scripts/oquery.js create-ticket "..."` — create a ticket
- Inspection commands: `node scripts/oquery.js tickets`, `oquery.js runs`, `oquery.js logs`, etc.
- Tests: individual suites run directly (`node scripts/<suite>-test.js`); the full release gate is `TEST_DATABASE_URL='postgresql://...' npm run checkpoint:release` (see `docs/RELEASE_CHECKPOINT.md`)
- Reading files (inspection only)

## Forbidden

- Agent access to files outside `workspace-root`
- Direct edits to workspace/user files when evaluating the agent pipeline
- Direct edits to any data store
- Throwaway HTTP/ticket-creation scripts
- Silently repairing bad agent output
- Any mutation that bypasses the ticket → agent → record pipeline

## When Output Is Wrong

Do not fix it yourself. Create a repair ticket:

```
node scripts/oquery.js create-ticket "repair: <what is wrong and what to fix>"
```

If the same issue persists across multiple repair tickets, that is signal too. Do not bypass.

## Missing Surface

If no proper mutation surface exists for what you need, stop work and report the gap. Do not improvise a bypass.

## Purpose

Evaluate the actual agent pipeline honestly. Contaminated provenance tells us nothing.
