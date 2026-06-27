# Local Connector Contract

r1.30 implements the smallest connector boundary using a **local/mock connector only**, per
`docs/CONNECTOR_BOUNDARY_DESIGN_AUDIT.md`. It proves connector boundaries, receipts, scoping, and
permission behavior **without adding any real external connector**.

## Scope and non-goals

- **Local/mock only** — the only `kind` is `local_mock`, which reads from a local fixture object
  store (`data/local-connector-objects.json`). There is **no external system, OAuth, Google Drive,
  Slack, Gmail, Discord, external API call, API key, or plaintext secret**, and **no background
  sync**.
- The local object store is a **test/demo fixture, not final product seed data**. Businesses will
  connect their own data through future, separately-audited connectors.

## Stores

- `data/connectors.json` — connector records.
- `data/connector-receipts.json` — one receipt per read/refused-write.
- `data/local-connector-objects.json` — the mock object fixture.

## Connector shape

`{ id, name, status(active|paused|archived), kind(local_mock), workContextId, credentialRef,
allowedScopes(read|write), sourceRoots, targetRoots, readPolicy, writePolicy, receiptPolicy,
syncPolicy{mode:'manual'}, ... }`.

- A new **active** connector requires an **active** Work Context.
- **No plaintext secret may be stored** — the record holds a `credentialRef` only; any
  `credential`/`secret`/`apiKey`/`token`/`password` field is rejected.
- **`connector:manage`** gates CRUD; **`connector:read`** gates reads; **`connector:write`** gates
  the write endpoint (which still refuses). Connector permission is **not** ticket authority.

## Receipt shape

`{ id, connectorId, workContextId, operation(read|read_refused|write_refused), sourceRef, targetRef,
externalObjectId, ticketId, runId, actor, timestamp, request{bounded}, result{status, bytes, hash,
reason?}, error }`.

- Receipts store **metadata + hash only — never full content**.

## Read behavior

`POST /api/connectors/:id/read` (needs `connector:read`):
- the connector must be **active**, its Work Context **active**, and its kind `local_mock`;
- `read` must be in `allowedScopes`;
- the object must be **under `sourceRoots`** (no traversal) and belong to the **same Work Context**;
- on success it returns **bounded content in the API response** and writes a receipt with
  `{status:'ok', bytes, hash}` (content not persisted);
- a missing object records a `failed` receipt; an out-of-bounds / cross-context / inactive request
  records a `read_refused` receipt. It **never guesses**, creates no ticket/run, and mutates no
  workspace.

## Write behavior (refused in r1.30)

`POST /api/connectors/:id/write` (needs `connector:write`) **always refuses** with reason
`write_disabled_in_r1.30` and records a `write_refused` receipt. This proves that **connector
availability is not write authority** — even a connector with a `write` scope performs no external
mutation in r1.30.

## UI

`/connectors` (list) and `/connectors/:id` (detail with recent receipts), nav gated by
`connector:manage`. The credential is shown as a **reference only**, never a value. No OAuth/API-key/
Google/Slack/Gmail/sync/chat UI.

## Timeline

r1.30 connector reads are standalone (no `ticketId`/`runId` tie), so **connector-receipt timeline
projection is deferred** — receipts are visible on the connector detail page. No connector timeline
ledger is created and source precedence is unchanged.

## Boundaries (unchanged by r1.30)

No external connector, no OAuth/API keys/secrets, no background sync, no hidden work, no ticket/run
creation, no workspace mutation, no scheduler/scheduled-token change, no model-provider-routing
change, no bounded-watcher change, no handoff change, no Work Context execution change, no
verification/triage/auto-retry change. The Target Provider remains the mutation boundary; a
watcher cannot mutate through a connector, and model routing cannot grant connector access. Old
tickets/runs/evidence are not rewritten and nothing is backfilled.
