# Operator Contract

## Roles

- **Operator** (Big Pickle or Codex): creates tickets, reads logs, inspects results, runs tests, reports issues.
- **Coding agent** (OpAgent-*): all material code changes. Runs via the agent pipeline.

## Mutation Pipeline

All material mutations must pass through:

```
ticket → agent run → recorded operations → replay/mutations
```

## Allowed Surfaces

- `node scripts/oquery.js create-ticket "..."` — create a ticket
- Inspection commands: `node scripts/oquery.js list-tickets`, `oquery.js get-run`, etc.
- Tests: `node --test`, `npm test`
- Reading files (inspection only)

## Forbidden

- Direct edits to workspace files (linkcheck/, governance-kernel/, etc.)
- Direct edits to `/tmp/op-data/*.json` or any data store
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
