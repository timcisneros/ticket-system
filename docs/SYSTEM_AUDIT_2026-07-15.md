# System Audit — 2026-07-15

## Outcome

The runtime remains aligned with the product direction: bounded agent or workflow execution,
deterministic authority checks, preserved operational evidence, and a path to higher deployment
capacity. The current implementation is at the internal-demo deployment stage; its single-process
JSON architecture is engineering work to advance before hosted or multi-tenant launch, not a
reduction of the product promise.

The audit covered objective compilation, startup and persistence integrity, run lifecycle and
recovery, authorization, server-rendered data exposure, request/session safeguards, verification
semantics, build coverage, CI, and release documentation.

## Findings addressed

| Area | Finding | Resolution |
| --- | --- | --- |
| Objective compiler | Experimental model compilation could alter every direct run, consume the execution request budget, and accept incomplete or broader contracts. | The compiler is default-off, reserves an execution request, records failed attempts, accepts only supported schemas, and requires exact mutation/postcondition parity. |
| Persisted JSON | Read or parse failures could be treated as empty data and then rewritten during startup. | Startup validation is read-only and fail-closed for malformed, non-array, strictly invalid or duplicate identities, referentially invalid, auxiliary, and runtime-limit data. Ticket identities are validated before normalization on both reads and writes. |
| Authorization | Some membership/permission administration paths did not require assignment authority; workflow administration reused a read permission; one SSE path lacked ticket-read enforcement. | Assignment checks are explicit, workflow administration has its own permission, and protected event streams use the same ticket-read boundary. |
| View data | Process-template views received complete agent records and inline data could break out of a script context. | Routes pass only `{id,name}` agent projections, inline JSON escapes script delimiters, and every dynamic agent label is constructed with DOM APIs and `textContent`. |
| Event durability | Queued event writes could advance an in-memory chain before persistence, restart chains at zero, and leave final-event tampering undetectable. | A persistent asynchronous journal performs bounded group commits; each caller resumes only after its batch write and sync complete, without blocking the event loop per event. Record, batch, and outstanding-work capacity are independently configured with strict startup validation; live utilization, high-water marks, commit timing, and rejection counts are operationally visible. Persistence failures stop both schedulers and fail closed. Restart restores one continuous per-run chain, hashes cover forensic metadata and payload, and every run and non-run event must satisfy the same strict envelope schema. |
| Run compatibility | Compatibility for old terminal event names, unsealed/reset chain segments, and missing run-limit snapshots added branches or reinterpreted old evidence using current settings. | Run evidence supports one schema (`schemaVersion: 1`) and one lifecycle (`run.execution_completed` then `run.terminalized`). Startup refuses old or unsealed events and any run missing its immutable run-limit snapshot before recovery begins. |
| Internal-demo HTTP boundary | The app still needed basic protection against cross-origin mutation, accidental public diagnostics, unsafe logout, and session-cookie mistakes without implying hosted production readiness. | Unsafe requests enforce same-origin checks, logout is POST-only, public health is minimal, local HTTP cookies are HttpOnly/SameSite, and secure cookies/HSTS activate only for an explicit HTTPS public URL. |
| Verification semantics | Fixture verifier metadata could appear to be an executed runtime verifier, and workflow verification could fall back to mutable workflow state. | Workflow runs verify only their immutable run-start contract snapshot. `run.postconditions_checked` records verifier metadata as `metadata_only_not_executed`; no separate event implies that metadata was executed. |
| Build and CI | The build checked only the main server file and the repository had no deterministic CI entry point. | The build parses all active CommonJS JavaScript sources. CI pins Node 24.17.0 and pnpm 11.8.0, then runs the build and deterministic release checkpoint. |

## Legacy policy

The product is still in development, so carrying compatibility for historical run formats would
create disproportionate branching and test overhead. The current policy is:

- preserve an explicit schema version and reject unsupported run evidence;
- do not migrate, reinterpret, or silently normalize old run event streams or missing immutable run snapshots;
- reset or regenerate local demo data when the run-event schema changes;
- add a migration only when real retained user data creates a concrete requirement.

This keeps failures visible while retaining a clean future migration boundary.

## What still needs to happen

1. **Advance the deployment architecture for scale.** Sessions are in memory, persistence is
   multi-file JSON, and the writer model is single-process. Define and implement the shared-session,
   transactional-storage, concurrency, and tenant-isolation milestones required for hosted launch.
2. **Close semantic verification gaps.** Prose acceptance criteria guide the agent but are not
   proof. Add only bounded deterministic postconditions; keep real-model benchmarks observational.
3. **Finish experimental validation.** The model contract compiler and prefix truncation remain
   default-off. Dependent mutation graphs are not validated for truncation.
4. **Improve shutdown cancellation.** Event evidence is durably flushed, but active provider calls do
   not share a process-wide cancellation signal.
5. **Reduce browser inline policy.** Current views still require CSP `unsafe-inline`; extracting
   scripts/styles or using nonces would allow a stricter policy later.
6. **Define the transactional-store transition.** Cross-file JSON updates are not transactions.
   Preserve clean storage boundaries now and move before measured capacity or reliability needs
   exceed the single-writer architecture.

## Verification status

Focused regressions completed during this audit:

- project-wide JavaScript syntax: pass;
- current event-envelope and chain tamper suite: 12/12 pass;
- restart chain-continuity and graceful shutdown: pass;
- startup data integrity, including refusal of legacy run events: pass;
- internal-demo HTTP/session safeguards: pass;
- workflow execution and immutable verification snapshot: pass;
- resume safety analysis: 10/10 pass.

The final deterministic release checkpoint passed **54/54 checks**. No
live-provider benchmark is claimed here.
