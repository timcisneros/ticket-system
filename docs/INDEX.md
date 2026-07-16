# Documentation Index

A compact map of current guidance and historical design/release records for the bounded ticket/run
substrate.

## Documentation lifecycle

- Living documents have stable, non-versioned names and describe current behavior. Update them when
  the implementation, product direction, or operating guidance changes.
- Documents explicitly marked historical, including versioned release notes and release audits, are
  snapshots. Do not revise their claims or verification counts after the fact; make only a
  stable-link repair when necessary.
- Put current conclusions in `SYSTEM_STATUS.md` or the relevant living contract/guide. Git history
  retains superseded states, so living documents do not need an accumulating remediation ledger.

## Start here

- [`../README.md`](../README.md) — project summary, quick start, release overview.
- [`SETUP_AND_FIRST_RUN.md`](SETUP_AND_FIRST_RUN.md) — install, env, first-run walkthrough.
- [`OPERATOR_GUIDE.md`](OPERATOR_GUIDE.md) — how to operate the system; safe operating rules.
- [`PRIMITIVE_GLOSSARY.md`](PRIMITIVE_GLOSSARY.md) — precise definitions + commonly confused terms.
- [`SYSTEM_STATUS.md`](SYSTEM_STATUS.md) — current guarantees, product direction, and known work.

## Operator / primitive docs

- [`TARGET_PROVIDER_CONTRACT.md`](TARGET_PROVIDER_CONTRACT.md) — the mutation boundary.
- [`RUN_EVIDENCE_AUTHORITY_SOURCE_OF_TRUTH_AUDIT.md`](RUN_EVIDENCE_AUTHORITY_SOURCE_OF_TRUTH_AUDIT.md) — source-of-truth model.
- [`TICKET_TIMELINE_AND_AUTHORITY_VISIBILITY.md`](TICKET_TIMELINE_AND_AUTHORITY_VISIBILITY.md) — timeline projection.
- [`PROCESS_TEMPLATE_ACTIVATION_DURABILITY.md`](PROCESS_TEMPLATE_ACTIVATION_DURABILITY.md) — activation reconciliation.
- [`WORK_CONTEXT_PRIMITIVE.md`](WORK_CONTEXT_PRIMITIVE.md) / [`WORK_CONTEXT_VISIBILITY_SURFACE.md`](WORK_CONTEXT_VISIBILITY_SURFACE.md) — Work Context.
- [`AGENT_HANDOFF_QUEUE_PROTOCOL.md`](AGENT_HANDOFF_QUEUE_PROTOCOL.md) / [`HANDOFF_SMOKE_TESTS_AND_DEMO_SCENARIOS.md`](HANDOFF_SMOKE_TESTS_AND_DEMO_SCENARIOS.md) — handoff.
- [`BOUNDED_WATCHER.md`](BOUNDED_WATCHER.md) — bounded watcher.
- [`MODEL_PROVIDER_ROUTING.md`](MODEL_PROVIDER_ROUTING.md) — routing policy + run snapshot.
- [`LOCAL_CONNECTOR_CONTRACT.md`](LOCAL_CONNECTOR_CONTRACT.md) — local/mock connector.
- [`OPERATIONAL_TRANSPARENCY.md`](OPERATIONAL_TRANSPARENCY.md) — `/ops` surface.

## Design rationale / audits

- [`CONNECTOR_BOUNDARY_DESIGN_AUDIT.md`](CONNECTOR_BOUNDARY_DESIGN_AUDIT.md)
- [`MODEL_PROVIDER_ROUTING_DESIGN_AUDIT.md`](MODEL_PROVIDER_ROUTING_DESIGN_AUDIT.md)
- [`BOUNDED_WATCHER_DESIGN_AUDIT.md`](BOUNDED_WATCHER_DESIGN_AUDIT.md)
- [`WORK_CONTEXT_PRIMITIVE_DESIGN_AUDIT.md`](WORK_CONTEXT_PRIMITIVE_DESIGN_AUDIT.md)
- [`AGENT_HANDOFF_QUEUE_PROTOCOL_AUDIT.md`](AGENT_HANDOFF_QUEUE_PROTOCOL_AUDIT.md)

## Current verification / release guidance

- [`RELEASE_CHECKPOINT.md`](RELEASE_CHECKPOINT.md) — the release gate + hygiene flow.
- [`SYSTEM_STATUS.md`](SYSTEM_STATUS.md) — living system status and verification authority.
- [`SAFETY_AND_NON_GOALS.md`](SAFETY_AND_NON_GOALS.md) — safety model + explicit non-goals.
- [`DEMO_WALKTHROUGH.md`](DEMO_WALKTHROUGH.md) — deterministic, no-provider demo click path.

## Historical release snapshots

- [`RELEASE_CANDIDATE_AUDIT.md`](RELEASE_CANDIDATE_AUDIT.md) — frozen r1.32 release-candidate verdict.
- [`RELEASE_NOTES_r1.33.md`](RELEASE_NOTES_r1.33.md) — frozen r1.33 release-candidate notes.
