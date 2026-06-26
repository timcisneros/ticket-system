# Local Workspace Target Provider Contract

## Milestone

r1.14 formalizes the existing local workspace as the first `TargetProvider`. The implementation remains local-provider-only and preserves the existing workspace operation behavior.

No connector registry, external provider configuration, remote target selection, or connector implementation is included.

## Provider shape

The local workspace provider exposes:

- Stable target id: `local-workspace`.
- Target kind: `localWorkspace`.
- Filesystem root scope identity.
- Explicit capabilities for list, read, create, write, rename, delete, snapshots, and receipts.
- The existing local workspace methods and error behavior.

`getRunWorkspaceProvider` still always returns this single local provider.

## Compatibility

Existing fields and behavior remain in place:

- `workspaceRoot` is retained.
- Existing operation names and result shapes are retained.
- Path normalization, traversal rejection, hidden path handling, realpath containment, type checks, content hashes, and local filesystem semantics are unchanged.
- Existing replay, event, log, and operation-history fields are not renamed or removed.

## Provider-neutral evidence

New operation evidence includes:

- `targetId`
- `targetKind`
- `targetScope`
- `targetPath`
- `targetResourceId`

Read operations include a `readReceipt` with target identity, operation, path, timestamp, run/ticket/actor context, metadata, and partial/truncation markers. `readFile` receipts include content size and hash without adding another stored content copy.

Mutating operation-history records include a `mutationReceipt` with operation id, target identity, before/after metadata, changed/created/deleted resources, provider response, authority decision, actor/run/ticket context, and normalized error information when applicable.

## Snapshot metadata

Replay snapshots identify the target provider and retain bounded root target snapshots. Snapshot metadata states that root listings are bounded and partial, records the entry count and limit, and preserves the existing truncation marker.

## Replay boundary

These receipts improve local auditability and provide a provider-neutral evidence shape. They do not make replay safe for external connectors. Connector-grade replay still requires provider-native resource identity, version/etag preconditions, idempotency behavior, dry-run semantics, and explicit remote delete/rename rules.

External connector work remains deferred until this contract is stable.
