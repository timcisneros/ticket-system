# Workflow Policy Verifier Architecture

## Validated Architecture

- Workflow is the work primitive.
- Policy is workflow metadata.
- Verifier contract is workflow metadata.
- Manifest and verifier oracle stay outside the agent workspace.
- Workspace contains source materials and produced artifacts only.
- Replay records evidence of the exact workflow, policy, and verifier versions used, including policy text hash.

## Validated Domains

- Legal Intake
- Vendor Compliance

## Relevant Commits

- `e81f1f8` Add workflow policy metadata for Legal Intake
- `db53a5c` Fit legal intake fixture to read budget
- `d0bdc86` Add vendor compliance workflow fixture
- `88f593a` Fix workflow mutation cap terminal step handling

## Explicit Non-Decisions

- No policy registry.
- No new top-level policy primitive.
- No UI.
- No workspace policy artifacts.
- No runtime authority changes.

## Next Recommended Validation Domain

Shared Drive Cleanup.

Reason: it adds real workspace mutation and file-operation risk beyond classification and artifact-writing workflows.
