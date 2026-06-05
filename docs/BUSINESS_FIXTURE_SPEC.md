# Business Fixture Spec

## Status

This document is the authoritative specification for business fixtures.

It replaces the planning intent in:

- `docs/BUSINESS_FIXTURE_PLAN_V2.md`
- `docs/BUSINESS_FIXTURE_REALISM_AUDIT.md`

`docs/BUSINESS_FIXTURE_PLAN.md` is superseded. Its file-routing model is not authoritative.

## Purpose

Business fixtures are demo and evaluation environments only.

They approximate business decision-making workloads on top of the current filesystem workspace because files are the runtime substrate available to agents. They do not describe final product runtime architecture. They do not imply that real businesses should use filesystem folders as their workflow engine.

Real deployments should connect to the customer's own source systems, data stores, and workflow tools. Examples include legal intake systems, ticketing systems, vendor management systems, shared drives, document stores, spreadsheets, and internal databases.

Fixtures evaluate whether an agent can:

- Inspect source materials.
- Apply stated business rules and context.
- Produce reviewable business artifacts.
- Avoid hallucinating inputs, IDs, policies, or decisions.
- Preserve source evidence unless the fixture explicitly requires filesystem cleanup.

## Non-Goals

Fixtures are not:

- Product architecture.
- A workflow engine design.
- A claim that filesystem routing is a real business process.
- A substitute for customer integrations.
- A benchmark that should be made to pass by weakening runtime authority or verification.

## Evaluation Boundary

Fixture success demonstrates capability within a controlled evaluation environment.

Fixture success does not demonstrate:

- integration readiness
- production reliability
- customer-specific workflow compatibility
- scalability beyond the fixture definition

Production validation requires execution against real customer data sources.

## Design Principles

Business-state fixtures read source materials and write business-state artifacts. Source materials stay in place unless the fixture is explicitly a filesystem-operation fixture.

Produced artifacts should resemble what a human business owner would review: trackers, registers, triage plans, summaries, audit reports, escalation lists, and cleanup logs.

Success criteria should be business outcomes, not folder placement. Examples:

- Legal: all matters are tracked with plausible dispositions and next actions.
- Support: urgent tickets are identified, assigned, and escalated.
- Vendor compliance: vendors are evaluated against stated policy evidence.
- Shared drive cleanup: stale, duplicate, or inconsistent files are handled without data loss.

The filesystem is a substrate for evaluation, not the product.

## Fixture Types

| Fixture | Type | Source Handling | Expected Output |
| --- | --- | --- | --- |
| Legal Intake Tracker | Business decision | Inputs remain in place | `intake-register.csv`, `matter-summary.md` |
| Customer Support Triage Plan | Business decision | Inputs remain in place | `triage-plan.md`, `escalation-list.md` |
| Vendor Compliance Decision Register | Business decision | Inputs remain in place | `vendor-decision-register.csv`, `compliance-review.md` |
| Shared Drive Cleanup | Filesystem operation | Some inputs may be moved | `migration-report.md`, `cleanup-log.csv`, cleaned workspace |

Only Shared Drive Cleanup should require mutating source files. That fixture is realistic because the business output is a cleaned filesystem. The other fixtures should represent state changes through generated artifacts.

## Realism Constraints

Fixture inputs may be simplified into Markdown, text, and CSV files, but the business shape must remain credible.

Each fixture must define:

- A real business owner.
- A realistic trigger event.
- Source materials with enough context to support the decision.
- Produced artifacts a human reviewer would recognize.
- Success metrics tied to business outcomes.
- Edge cases that test reasoning, not only keyword matching.

Fixtures must avoid treating "move the file to a folder" as the primary representation of a business decision. Legal, support, and vendor decisions should be recorded in documents or structured registers.

Fixtures should include relevant business context:

- Legal intake: urgency, business unit, matter type, missing fields, duplicate or out-of-scope requests.
- Support triage: customer tier, impact, scope, issue type, escalation signals, duplicate reports.
- Vendor compliance: policy requirements, spend or criticality, certification validity, incidents, remediation options.
- Shared drive cleanup: metadata, duplicate evidence, active references, stale criteria, naming policy.

Scale must match the expected mode of work:

- 10 items: individual review is acceptable.
- 50 items: individual review is possible but should focus on structured artifacts.
- 500+ items: bulk detection should be precomputed or scripted; the agent should review exceptions or produce reports, not manually inspect every file.

## Fixture 1: Legal Intake Tracker

### Business Owner

Legal operations manager or in-house counsel at a company with recurring legal volume.

### Source Materials

Markdown intake forms in `legal-intake/incoming/`. Each form should include fields such as:

- Matter Type
- Requesting Party
- Contact Email
- Jurisdiction
- Business Unit
- Description
- Urgency

The fixture should include complete, incomplete, duplicate, urgent, vague, jurisdiction-mismatch, and out-of-scope examples.

### Business Decision

For each intake, decide a disposition such as:

- `Open Matter`
- `Request Information`
- `Decline`
- `Duplicate`

The decision must be justified from the source form. Missing information should not automatically imply rejection unless the fixture's stated rules make the request unworkable. Urgency and business context should affect the reasoning when provided.

### Produced Artifacts

- `legal-intake/intake-register.csv`
- `legal-intake/matter-summary.md`

The register should include intake ID, matter type, requesting party, disposition, reason, and next action.

### Success Criteria

- Every source intake appears exactly once in the register.
- Dispositions are consistent with the source fields and stated rules.
- Missing information and out-of-scope requests have specific next actions.
- Duplicate or related requests are identified when seeded.
- The summary helps a legal lead plan follow-up work.
- No nonexistent intake IDs or facts appear.

## Fixture 2: Customer Support Triage Plan

### Business Owner

Support team lead or customer success manager.

### Source Materials

Support ticket files in `support-inbox/`. Tickets should include:

- Ticket ID
- Subject
- Description
- Customer
- Customer tier
- Impact
- Reported time
- Category or signal where appropriate

The fixture should include production outages, partial bugs, questions, feature requests, enterprise-customer ambiguity, possible security issues, duplicate reports, and internal tickets.

### Business Decision

For each ticket, determine:

- Priority.
- Assignee team.
- Escalation status.
- First-response SLA.
- Suggested first response or next action.

### Produced Artifacts

- `support-queue/triage-plan.md`
- `support-queue/escalation-list.md` when P1 or escalation items exist.

### Success Criteria

- Every source ticket appears in the triage plan.
- P1 or escalation-worthy tickets are surfaced clearly.
- Assignment is plausible from issue type, impact, and customer context.
- The escalation list includes every ticket marked for escalation.
- No nonexistent ticket IDs or customer facts appear.

## Fixture 3: Vendor Compliance Decision Register

### Business Owner

Procurement compliance officer or third-party risk manager.

### Source Materials

Vendor packets and policy files. Vendor packets may be represented as Markdown files, but should stand in for real evidence such as questionnaires, certifications, DPAs, incident records, and vendor profiles.

Inputs should include:

- Vendor profile.
- Data processing agreement.
- Security certification or explicit absence.
- Certification expiry date.
- Vendor criticality or spend tier.
- Incident records where applicable.
- Policy documents with concrete decision rules.

### Business Decision

For each vendor, determine:

- `Approve`
- `Conditional Approve`
- `Reject`

The decision must cite policy evidence and vendor evidence. Expired certifications, active incidents, missing documents, and criticality should be handled according to the fixture's stated policy.

### Produced Artifacts

- `vendors/vendor-decision-register.csv`
- `vendors/compliance-review.md`

### Success Criteria

- Every vendor packet appears in the register.
- Each disposition is supported by source evidence and policy rules.
- Each row cites a policy reference or evidence source.
- Remediation or next action is specific for conditional and rejected vendors.
- The review is suitable as an audit-facing summary.
- No nonexistent vendors, certifications, incidents, or policy clauses appear.

## Fixture 4: Shared Drive Cleanup

### Business Owner

IT administrator, records manager, or knowledge management lead.

### Source Materials

A shared-drive-like directory tree containing active files, stale files, duplicate content, and naming inconsistencies.

Unlike the business-decision fixtures, this fixture may require source-file mutations because the business output is a cleaned filesystem.

### Business Decision

For each file or file group, determine:

- Current and preserved.
- Stale and moved to archive.
- Duplicate and moved or logged according to policy.
- Naming inconsistency and normalized according to policy.

The fixture must state the policy for selecting canonical files. It should not rely on arbitrary "first seen" behavior unless that rule is explicitly documented as the evaluation policy.

The fixture manifest must define:

- Canonical-file selection.
- Stale threshold.
- Duplicate handling.
- Naming policy.
- Allowed mutation set.
- Exact files in scope.

### Produced Artifacts

- `shared-drive/migration-report.md`
- `shared-drive/cleanup-log.csv`
- Created cleanup folders when required by the fixture policy.

### Success Criteria

- Cleanup report accounts for the fixture's relevant files.
- Active files are preserved.
- Stale and duplicate handling follows stated policy.
- Every file mutation appears in the cleanup log with original path, action, new path, and reason.
- No files are deleted unless a future fixture explicitly says deletion is required.
- Scale is appropriate for agent review, or bulk-detection evidence is precomputed.

## Generator Requirements

Any future fixture generator must be deterministic, bounded, and safe by default.

Required behavior:

- Require an explicit `--seed`; do not default to `Date.now()` or any other current-time value.
- Do not generate current-time timestamps.
- Use fixed fixture dates derived from the seed or from explicit CLI parameters.
- Include a dry-run mode that reports planned writes without changing the filesystem.
- Refuse to run unless the target is an explicitly disposable fixture workspace.
- Refuse to overwrite existing fixture files unless `--overwrite` is explicitly supplied.
- Write a manifest that records seed, parameters, schema version, generated paths, expected outputs, and fixture policy.
- Keep generated paths inside the configured fixture workspace.
- Use stable ordering for generated files, manifest entries, and stdout.

The generator should not mutate operational app data, runtime data, `.local-data`, or non-fixture workspace content.

The manifest must record:

- Fixture name.
- Fixture version.
- Seed.
- Parameters.
- Fixed evaluation date.
- Expected artifact schema.
- Expected decisions or acceptable decision sets.

## Verifier Requirements

Any future verifier must be deterministic and strict enough to catch wrong reasoning.

Required behavior:

- Verify against the fixture manifest and source materials.
- Prefer structured parsing for CSV, JSON, and manifest data.
- Avoid loose string-only pass criteria where structured checks are possible.
- Check coverage: every source item is accounted for exactly once unless the fixture explicitly allows grouping.
- Check no hallucination: no unknown source IDs, vendor IDs, ticket IDs, policy references, or file paths.
- Check decision consistency against deterministic expected outputs or explicit policy rules.
- Check required artifacts exist and have required structured fields.
- Check source preservation for business-state fixtures.
- Check mutation logs and no-data-loss constraints for filesystem-operation fixtures.
- Exit nonzero on failure and print actionable failure messages.

String checks may supplement structured validation, but should not be the only pass condition for important decisions when structured output is required.

Automated pass/fail must be derived from:

- Fixture manifest.
- Fixed fixture policy.
- Structured artifacts.
- Expected decisions or acceptable decision sets.

Automated pass/fail must not depend on verifier discretion.

If expected outputs and policy rules both exist, the manifest is authoritative. Policy-rule fixtures must encode acceptable outcomes in the manifest.

## Recommended Implementation Order

1. Legal Intake Tracker.
2. Customer Support Triage Plan.
3. Vendor Compliance Decision Register.
4. Shared Drive Cleanup.

The first implementation should keep scope small: one fixture, one generator path, one verifier path, and a manifest format that can grow after it proves useful.

## Current Script Sync Status

The current untracked `scripts/fixture-generator.js` and `scripts/fixture-verifier.js` are not yet authoritative implementations of this spec.

Known gaps:

- The generator currently allows time-derived defaults.
- The generator currently writes directly into `WORKSPACE_ROOT` without the required disposable-workspace guard.
- The generator lacks required dry-run and explicit overwrite behavior.
- Some generated fixture logic does not include the edge cases specified here.
- Some verifier checks are loose string checks where structured validation should be used.
- Some fixture semantics are not aligned between the scripts and this spec.

Do not treat the current scripts as committed evaluation infrastructure until they are revised against this document.
