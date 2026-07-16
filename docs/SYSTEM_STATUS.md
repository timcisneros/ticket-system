# System Status

> This is a living description of the current implementation, product direction, and known work.
> Update it when those facts change. Prior states belong in Git history or explicitly historical
> release documents, not in an accumulating findings ledger here.

## Product direction

The product direction is bounded agent and workflow execution with deterministic authority,
preserved operational evidence, and a path to scalable hosted deployment. The current implementation
uses a single Fastify process and JSON-file persistence. That is the present engineering stage, not
the intended deployment ceiling.

## Current runtime guarantees

- Tickets and runs are the visible units of work. Agent and workflow actions pass through runtime
  authority, evidence, evaluation, and consequence surfaces.
- Startup validates persisted identities, references, runtime-limit snapshots, and the event stream
  before recovery. Invalid current-format data fails closed instead of being treated as empty.
- Event append uses a persistent asynchronous group-commit journal. A caller resumes only after its
  exact batch has been written and `FileHandle.sync()` has completed.
- Process-local event append admission has configurable record, batch, and outstanding-work bounds.
  Current admission utilization, capacity waits, high-water marks, commit timing, and rejections are
  visible through the runtime and operational status surfaces. Capacity pressure pauses already
  accepted event producers, rejects new mutation admission, and clears automatically after durable
  appends drain. Oversized records are request-scoped rejections; write or sync failure remains a
  fatal-for-the-current-process mutation shutdown. These controls do not bound the total size of
  `events.jsonl`, which has no automatic rotation, compaction, or retention policy.
- Run events use one current schema and one continuous per-run hash chain. Runtime evidence is not
  silently reinterpreted with current configuration.
- Assignment, workflow administration, protected event streams, and target mutations enforce their
  respective authority boundaries.
- Different-ticket runs can execute concurrently, subject to provider-specific concurrency limits.
  They are not unconditionally independent: overlapping cross-ticket workspace writes can be
  refused, while per-ticket lifecycle transitions are coordinated for consistency.
- Workflow verification uses the immutable run-start verification contract. Fixture-verifier
  metadata is identified as metadata and is not represented as an executed runtime verifier.
- The build parses active CommonJS sources, and CI runs the deterministic release checkpoint.

## Compatibility and development data

Compatibility is format-specific, not a system-wide no-legacy policy:

- Current run evidence requires the current event envelope and an immutable run-limit snapshot;
  startup rejects missing or unsupported evidence at that boundary.
- Other older records remain supported where current code and tests require it. Examples include
  rendering unversioned process-template provenance and normalizing absent newer ticket fields.
- Disposable development data may be reset or rejected after an incompatible format change when
  compatibility has no product value.
- A strict development-data boundary does not commit a future hosted system to avoiding migrations.
  Retained user data and the target storage architecture should determine production migration
  policy.

## Known work

1. Advance shared-session, transactional-storage, concurrency, and tenant-isolation architecture
   before measured capacity or reliability requirements exceed the single-writer implementation.
   Process-local append admission is not a substitute for shared durable infrastructure.
2. Add bounded deterministic postconditions where prose acceptance criteria do not prove outcomes;
   keep real-model benchmarks observational.
3. Complete validation of the model contract compiler and prefix truncation before enabling them by
   default, including dependent mutation graphs.
4. Add process-wide cancellation for active provider calls during shutdown.
5. Remove the browser's dependency on CSP `unsafe-inline` through extracted assets or nonces.

## Verification authority

Verification claims should come from executable checks, not a copied result count in this document:

```sh
npm run build
npm run checkpoint:release
npm run benchmark:operational-endurance
```

The checkpoint is deterministic and provider-free. Real-provider benchmarks remain observational
and must be reported separately when they are actually run.
