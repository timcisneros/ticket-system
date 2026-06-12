# Legal Intake Workflow Milestone

## Commits

- `0e26c13` Add authoritative business fixture spec
- `c5facd6` Align legal intake fixture generation
- `88f593a` Fix workflow mutation cap terminal step handling
- `e81f1f8` Add workflow policy metadata for Legal Intake
- `db53a5c` Fit legal intake fixture to read budget

## Final Validation

Fresh isolated validation passed using a temp `DATA_DIR` and fresh marked fixture workspace.

- Run status: `completed`
- Fixture verifier: `PASS`
- Coverage: `8/8`
- Disposition accuracy: `8/8`
- Workspace policy artifacts: none
- Writer lock cleared after shutdown: yes

Replay `workflowInvocation` recorded:

- `workflowId`: `legal-intake`
- `workflowVersion`: `1`
- `policyId`: `legal-intake-decision-policy`
- `policyVersion`: `1`
- `policyTextHash`: `0640d3948791a66082bc06f104da5e5e384f820db7ac453b3f0022a2559b19ec`
- `verifierContractId`: `legal-intake-verifier`
- `verifierContractVersion`: `1`

## Product Boundary

- Workspace is for work materials only: source intakes, generated register, generated summary.
- Workflow is the work primitive: Legal Intake runs as a workflow ticket, not as ad hoc direct-agent prompt policy.
- Policy and verifier contracts are workflow metadata, not top-level product primitives.
- Manifest and verifier oracle remain outside the agent workspace contract and are used for evaluation only.
- Replay records the workflow, policy, and verifier versions plus policy text hash for durable evidence.

## Remaining Untracked Docs

- `anchored-summary.md`
- `docs/BUSINESS_FIXTURE_PLAN.md`
- `docs/BUSINESS_FIXTURE_PLAN_V2.md`
- `docs/BUSINESS_FIXTURE_REALISM_AUDIT.md`
- `docs/decision-memo-same-run-conflict-scope.md`
- `docs/decision-record-truthfulness-over-boundedness.md`
- `docs/evidence-boundary-same-run-conflict-scope.md`
- `terminal-classification.md`

## Next Recommended Tranche

FB-15 should focus on evaluation harness stabilization, not runtime changes:

- Add a reusable command or script that runs the Legal Intake workflow fixture end to end in an isolated `DATA_DIR` and marked fixture workspace.
- Record run status, verifier result, coverage, disposition accuracy, replay metadata, and writer-lock cleanup.
- Keep verifier oracle outside the agent workspace.
- Do not broaden policy into a registry or product subsystem until more than one workflow needs the same shape.
