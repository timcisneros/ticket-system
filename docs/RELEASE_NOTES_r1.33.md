# Release Notes — r1.33 (Release Candidate)

> Historical release notes. For current implementation status, see `SYSTEM_STATUS.md`. These notes
> are not updated with later results.

These notes summarize the release-candidate state captured by `docs/RELEASE_CANDIDATE_AUDIT.md` at
master `f46d2b0` (tag `r1.33-release-candidate-audit`). This is a **release candidate**, not a final
`v1.0` tag, and **not a production-readiness claim**.

## Current release-candidate state

A **bounded ticket/run substrate** — internally coherent, bounded, and test-covered. The audit found
**no P0 and no P1 blockers**; verdict: **ready for release documentation**.

## Key primitives shipped (through r1.32)

- **Runtime substrate:** Ticket → Run → Authority → Target Provider → Evidence/Receipt; Verification;
  Triage; per-ticket Timeline projection.
- **Process templates & schedules**, with append-only versioning and **activation durability**
  reconciliation (r1.12.2).
- **Work Context** primitive (r1.20) and **visibility surface** (r1.21).
- **Agent handoff queue protocol** (r1.23) with a deterministic **smoke loop** (r1.24).
- **Bounded watcher** — manual observer/proposer (r1.26).
- **Model/provider routing** — dispatch policy + immutable per-run `routingSnapshot` (r1.28).
- **Local/mock connector contract** — bounded read with receipt, write refused (r1.30).
- **Operational transparency** — read-only `/ops` summary (r1.31).
- **Hardened release checkpoint** — coverage guard + existence pre-check (r1.32).

## Checkpoint

`npm run checkpoint:release` → **43/43 checks**, provider-free, network-free, deterministic,
temp-`DATA_DIR`/`WORKSPACE_ROOT` safe.

## No P0 / P1 blockers

No hidden execution path; no authority bypass; no target mutation without a receipt; no external
connector credential surface; no cross-context data leak; checkpoint green. Triage is annotate-only;
blocked work is surfaced; the operational surface is adequate.

## P2 notes (known limitations, non-blocking)

- No real external connector yet (only the `local_mock` contract).
- Legacy records may lack newer fields by design (nullable, no backfill); they render safely.
- Model/provider/target/connector naming benefits from the new glossary
  (`docs/PRIMITIVE_GLOSSARY.md`).
- No production deployment guide yet.
- Activation two-write durability is reconciled at startup but not fully transactional.

## Backup branches

Three branches preserved from a prior reconciliation hold foreign concurrent work and the original
bad-stack commit: `backup/local-master-with-foreign-and-r1.28`, `backup/foreign-stack-before-r1.28`,
`backup/r1.28-commit-caec9a6`. They are **intentionally preserved and excluded from the release
flow** — never merged, pushed, deleted, or moved without an explicit owner decision. The shipped
r1.28 commit is the clean cherry-pick `8c00524`; the foreign commits are not ancestors of `master`.

## Next step

Release documentation (this milestone, `r1.34-release-documentation`), followed by the final tag
procedure. Do not add new primitives, real connectors, or model-provider integrations before release
docs are complete.
