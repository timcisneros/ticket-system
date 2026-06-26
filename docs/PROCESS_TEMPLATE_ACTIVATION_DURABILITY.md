# Process Template Activation Durability

Activating a new process-template version is committed across **two** separate atomic
writes:

1. **Version store** (`process-template-versions.json`) — supersede the prior active
   version, mark the draft `active` (stamping `activatedAt` / `supersedesVersionId`).
2. **Root template** (`process-templates.json`) — re-point the root's active content and
   version pointers (`currentVersion`, `currentVersionId`, `version`, `name`,
   `ticketTemplate`).

Each write is individually atomic, but there is no cross-file transaction. A crash **between**
write 1 and write 2 can therefore leave the two files temporarily inconsistent: the durable,
append-only version store has already recorded the new active version while the root still
points at the old one.

## What is authoritative

The **version store is the source of truth.** It is written first and its records are
immutable, append-only history. The root template is a *derived pointer* into that history —
it caches "which version is active right now" so triggers can stamp provenance without scanning
the store. When the two disagree, the root is reconciled **to** the store, never the reverse.

## Startup reconciliation

On boot — after run reconciliation and **before** the template scheduler starts — a
conservative, deterministic reconciler (`reconcileProcessTemplateVersionConsistencyOnStartup`)
converges each template's root pointer to the store's single active version.

It runs before the scheduler so a scheduled template can never trigger against a stale root.

### When repair is safe (and happens)

- **Clean / consistent** — root already matches the single active version record: **no change**.
- **Crash window** — the store has exactly **one** active version whose number is the **same as
  or newer than** the root pointer (e.g. store active `v2`, root still `v1`): the reconciler
  finishes the interrupted activation by re-pointing the root forward to that active version
  (content + version pointers only). This direction is exactly what the activation write order
  can produce, so it is deterministic.

Repair touches **only** the root's content/version-pointer fields. It stamps `updatedBy:
"system"`. It is idempotent: once the root matches the active record, a re-run makes no change.

### When repair refuses (logs an unresolved consistency issue, changes nothing)

The reconciler never guesses. It leaves state untouched and records a
`process_template:version_consistency_unresolved` audit entry when:

- **Root ahead of the store** — the root points at a version **newer** than the store's active
  version (e.g. root `v2`, store active `v1`). This cannot result from the forward write order
  (the root is written last), so it is treated as ambiguous corruption. The root is **never
  demoted** and a draft is **never activated**.
- **Multiple active versions** — the store has more than one `active` record for a template. The
  reconciler refuses to pick a winner.
- **No active version** — the store has records (e.g. a superseded version plus a draft) but
  none is `active`. A **draft is never auto-activated** to fill the gap.

### Never touched

Reconciliation is hardening, not behavior. It never:

- activates a draft, demotes a root, deletes or rewrites a version record;
- rewrites old tickets, old runs, or old trigger-ledger entries (provenance and
  `source.templateVersion` on existing tickets are preserved exactly);
- changes the schedule cursor (`nextRunAt` / `lastScheduledTriggerAt`), the `enabled` flag, or
  any scheduling behavior — there is no catch-up;
- creates a ticket, run, trigger token, or any workspace mutation.

**Legacy templates** that were never versioned (no records in the store) are left exactly as
they are.

## Scheduled tokens stay version-free

Reconciliation does not change scheduled-trigger token semantics. After a repaired activation a
scheduled trigger still produces a version-free token of the form
`schedule:<templateId>:<scheduledForIso>` — the version lives in provenance
(`source.templateVersion`), not in idempotency. Future generated tickets simply use the
now-consistent active root version.
