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
- Journal record, batch, and outstanding-work capacities are independently configurable. Current
  utilization, high-water marks, commit timing, and rejections are visible through the runtime and
  operational status surfaces.
- Run events use one current schema and one continuous per-run hash chain. Runtime evidence is not
  silently reinterpreted with current configuration.
- Assignment, workflow administration, protected event streams, and target mutations enforce their
  respective authority boundaries.
- Workflow verification uses the immutable run-start verification contract. Fixture-verifier
  metadata is identified as metadata and is not represented as an executed runtime verifier.
- The build parses active CommonJS sources, and CI runs the deterministic release checkpoint.

## Development-data policy

The product is still in development. Compatibility branches for old run formats would add runtime
and test complexity without retained user data to justify them. The current policy is therefore:

- keep explicit schema versions and reject unsupported evidence;
- do not migrate, reinterpret, or silently normalize old run streams or missing immutable run
  snapshots;
- reset or regenerate development data after an incompatible schema change;
- add a migration only when retained user data creates a concrete requirement.

## Known work

1. Advance shared-session, transactional-storage, concurrency, and tenant-isolation architecture
   before measured capacity or reliability requirements exceed the single-writer implementation.
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
