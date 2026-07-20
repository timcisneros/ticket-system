# Local Connector Contract

The current connector implementation establishes a connector authority boundary using a
**local/mock adapter only**. It proves catalog, receipt, Work Context, permission, and persistence
behavior without representing the product's future connector catalog as local-only.

## Current scope

- The only implemented adapter `kind` is `local_mock`. It reads from the disposable fixture object
  store `data/local-connector-objects.json`.
- There is no external system call, OAuth flow, Google Drive, Slack, Gmail, Discord, background sync,
  API-key ingestion, or plaintext credential storage in this implementation.
- The local object store is a test/demo fixture, not connector authority and not final product seed
  data. Future external adapters must preserve the authority and receipt contract and receive their
  own security and operational review.

## Persistence authority

Connector definitions and receipts use the `connector-authority` repository contract:

- The selected JSON development adapter persists definitions in `data/connectors.json` and receipts
  in `data/connector-receipts.json` under the process's existing single-writer authority.
- Migration `022_connector_authority.sql` supplies PostgreSQL `connectors` and append-only
  `connector_receipts` tables. PostgreSQL owns identity and timestamps, enforces revision and
  reference constraints, indexes catalog, Work Context, receipt, and refusal reads, and maintains
  exact status counts across 256 ID-derived shards.
- Catalog lists and receipt histories use bounded keyset cursors. A page bound limits query work; it
  does not cap the total number of connectors or receipts.
- Connector create/update and required diagnostic audit evidence roll back together in JSON or
  commit in one PostgreSQL transaction. Updates require the rendered/current `revision`; a stale
  writer receives a conflict instead of overwriting another update.
- Receipt append and its required diagnostic audit commit together. PostgreSQL receipts are
  database-enforced append-only. The JSON adapter retains its single-process file semantics.
- Persisted connector and receipt records must use the current format. Disposable obsolete records
  are rejected; there is no development-data importer or compatibility branch.

The active Fastify server still selects the JSON adapter. The PostgreSQL implementation is a
cutover-ready authority seam, not a dual-write mode or a claim that partial PostgreSQL server mode
is enabled. The mock object fixture intentionally remains file-backed because it is not a production
connector source.

## Connector record

`{ id, name, status(active|paused|archived), kind(local_mock), workContextId, credentialRef,
allowedScopes(read|write), sourceRoots, targetRoots, readPolicy, writePolicy, receiptPolicy,
syncPolicy{mode:'manual'}, revision, createdBy, createdAt, updatedBy, updatedAt }`.

- An **active** connector requires an **active** Work Context.
- The record holds a `credentialRef` only. Plaintext `credential`, `secret`, `apiKey`, `token`, or
  `password` fields are rejected recursively.
- `connector:manage` gates catalog management, `connector:read` gates reads, and `connector:write`
  gates the write endpoint. Connector permission is not ticket or target-operation authority.

## Receipt record

`{ id, connectorId, workContextId, operation(read|read_refused|write_refused), sourceRef, targetRef,
externalObjectId, ticketId, runId, actor, timestamp, request{bounded:true}, result{status, bytes?,
hash?, reason?}, error }`.

Receipts contain metadata and a SHA-256 hash for successful reads, never returned object content or
credentials. Receipt connector/Work Context references must agree. A successful read requires a
non-negative byte count and a lowercase SHA-256 hash.

## Read behavior

`POST /api/connectors/:id/read` requires `connector:read`:

- the connector and its Work Context must be active, its kind must be `local_mock`, and `read` must
  be in `allowedScopes`;
- the object identifier must be under `sourceRoots` without traversal and the fixture object must
  belong to the same Work Context;
- a successful read commits its metadata/hash receipt before returning the fixture content;
- a missing object commits a failed receipt; an out-of-scope, cross-context, or inactive request
  commits a `read_refused` receipt;
- no read creates a ticket/run or mutates the workspace.

Here, `bounded` describes authority scope and request admission. The local fixture adapter returns
the stored string as one response and does not independently enforce a response-byte limit. A real
external adapter needs an explicit configured size or streaming contract before it is enabled.

## Write behavior

`POST /api/connectors/:id/write` requires `connector:write` and currently always refuses with reason
`connector_write_disabled`, committing a `write_refused` receipt and its diagnostic audit. Connector
availability and an allowed `write` scope do not grant target-operation authority or perform an
external mutation.

## UI and CLI

`/connectors` provides a cursor-paged list. `/connectors/:id` shows one definition and a cursor-paged
receipt history. Management forms submit the current revision. The credential is shown only as a
reference. `oquery connectors` follows all catalog cursors, and `oquery connector-update` fetches the
current revision before submitting an update.

Standalone connector reads currently have null `ticketId`/`runId`, so receipts appear on connector
detail rather than in a ticket/run timeline. No additional connector timeline ledger is created.

## Product boundary

This implementation adds no external connector, credential exchange, background sync, hidden work,
ticket/run creation, workspace mutation, scheduler authority, watcher mutation path, model-routing
grant, verification change, triage change, or automatic retry. The target-provider contract remains
the mutation boundary. These are boundaries of the current implementation, not a decision to limit
the future hosted product to a local adapter or one process.
