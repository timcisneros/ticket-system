# Shared Drive Cleanup Design Review

## Goal

Determine whether Shared Drive Cleanup can use the existing workflow policy verifier architecture unchanged.

## Recommendation

Shared Drive Cleanup can be expressed with the existing architecture, but the first validation should be a small, explicit fixture rather than the current large generated drive.

No new primitive is required. No runtime authority change is required. No workspace policy artifact is required.

The fixture should use:

- Workflow metadata for policy, task template, and verifier contract.
- Workspace source materials for the shared-drive files only.
- Produced workspace artifacts for cleanup report and cleanup log.
- Replay evidence for workflow, policy, verifier versions, policy hash, read actions, authority checks, and file mutations.
- Manifest and verifier oracle outside agent decision context.

## Architecture Fit

| Surface | Fit |
| --- | --- |
| Workflow | Fits. The cleanup can be modeled as deterministic read/classify/mutate/report steps. |
| Policy metadata | Fits. Cleanup rules belong in workflow metadata, not in the workspace. |
| Verifier contract | Fits. Expected artifacts and fixture id belong on the workflow definition. |
| Replay evidence | Fits. Replay already records workflow invocation metadata, workflow actions, authority checks, and workspace operations. |
| Manifest oracle | Fits. The manifest should encode expected file classifications and acceptable mutations. It should remain outside the agent workspace. |
| Workspace boundary | Fits if the workspace contains only source files, generated cleanup folders, moved/renamed files, `migration-report.md`, `cleanup-log.csv`, and `fixture-manifest.json` as the outside-oracle fixture marker. |

## 1. Actual Business Decisions

For each file or duplicate group, decide:

- Preserve: current active file remains in place.
- Archive: stale file is moved to `shared-drive/archive/`.
- Duplicate: non-canonical duplicate is moved to `shared-drive/duplicates/`.
- Normalize: file with naming issue is renamed or moved according to naming policy.
- No action: file does not meet any mutation rule.

The decision is operational, not abstract classification: each decision must map to a concrete file action or an explicit no-op.

## 2. Actual Workspace Mutations

Minimal mutation set:

- `createFolder` for required cleanup folders.
- `renamePath` to move stale files into `archive/`.
- `renamePath` to move duplicate copies into `duplicates/`.
- `renamePath` to normalize names when policy requires it.
- `writeFile` for `shared-drive/migration-report.md`.
- `writeFile` for `shared-drive/cleanup-log.csv`.

Deletion should not be part of the first fixture. Overwrite behavior should be avoided by fixture construction and verified after execution.

## 3. Minimal Realistic Fixture

Use a small fixed fixture that fits current workflow budgets and still exercises file-operation risk.

Recommended first fixture:

- 8 source files total.
- 2 active/current files that must remain in place.
- 2 stale files that must move to `archive/`.
- 1 duplicate pair where the canonical file stays and the duplicate moves to `duplicates/`.
- 1 naming-inconsistent file that moves or renames according to policy.
- 1 ordinary no-action file.

The manifest must encode:

- Exact source paths.
- File ids or stable labels.
- Expected classification for each file.
- Canonical file for duplicate group.
- Stale threshold and fixed evaluation date.
- Expected mutation action and target path for each mutated file.
- Files expected to remain in place.
- Allowed mutation set.

This is more realistic for the current runtime than a 500-file cleanup. Large-drive cleanup should wait until bulk detection or staged inspection is validated.

## 4. Verifier Evidence That Proves Success

The verifier should prove:

- `migration-report.md` exists and references every expected cleanup category.
- `cleanup-log.csv` exists with exact columns such as `original_path,action,new_path,reason`.
- Every expected mutation appears exactly once in `cleanup-log.csv`.
- No unexpected mutation appears in `cleanup-log.csv`.
- Every expected moved file exists at the target path.
- Every preserve/no-action file remains at the original path.
- Original paths for moved files no longer exist.
- No source file content is lost: content hashes for moved files match manifest-recorded source hashes.
- No deletion occurred outside the expected move set.
- Required cleanup folders exist only if policy requires them.
- Replay contains matching `renamePath`, `createFolder`, and `writeFile` evidence for the same paths.
- Replay contains workflow/policy/verifier metadata and policy hash.

The current verifier is not sufficient yet. It checks artifact/folder presence and rough file-count preservation, but it does not deterministically verify exact expected mutations, content hashes, or cleanup-log correctness.

## 5. Required Policy Rules

Workflow policy metadata should define:

- Stale threshold: files older than the fixed evaluation date minus the configured threshold move to `archive/`.
- Canonical duplicate selection: the manifest-designated canonical file remains; duplicate copies move to `duplicates/`.
- Active-file protection: files marked active or referenced by active projects must not move even if naming is imperfect.
- Naming policy: define exact normalization rule and target location for naming fixes.
- Conflict policy: if target path exists, do not overwrite; log blocked conflict instead of moving.
- Mutation policy: allowed actions are folder creation, moves/renames, and report/log writes only.
- No-delete policy: deletion is forbidden in the first fixture.
- Audit policy: every mutation must be recorded in `cleanup-log.csv` with original path, action, new path, and reason.

These rules can be attached to workflow metadata exactly like Legal Intake and Vendor Compliance policies.

## 6. New Primitive Required?

No.

The existing workflow primitive is sufficient. Cleanup is a workflow that reads file evidence, applies workflow policy, executes bounded workspace mutations, writes audit artifacts, and records replay evidence.

## 7. Runtime Changes Required?

No runtime change is required for the first fixture if it is sized to current budgets and uses existing actions.

The fixture should avoid requiring bulk traversal beyond current action limits. If a larger cleanup later needs recursive inventory or hash-based duplicate detection, that should be evaluated as a separate runtime capability question after the small fixture passes or fails.

## 8. Workspace System Artifacts Required?

No policy or verifier artifacts should be placed in the workspace.

The workspace should contain source drive materials and produced cleanup artifacts. `shared-drive/fixture-manifest.json` remains the fixture oracle/marker used by the verifier, not agent policy source.

## 9. Authority Changes Required?

No.

The workflow should receive owned output authority only for the required `shared-drive/` paths. Runtime authority should continue to enforce protected paths and owned-output boundaries.

The verifier should confirm no mutation occurred outside the fixture paths.

## 10. Can It Be Expressed Entirely With Existing Surfaces?

Yes.

Shared Drive Cleanup can be expressed as:

- Workflow metadata: policy text, task prompt template, verifier contract.
- Source workspace materials: shared-drive files and directories.
- Produced outputs: moved/renamed files, cleanup folders, `migration-report.md`, `cleanup-log.csv`.
- Replay evidence: workflow invocation metadata, policy/verifier versions, policy hash, authority checks, workflow actions, and workspace operations.

## Current Implementation Gaps To Resolve Later

This review does not implement these changes, but the current scripts show gaps that would need correction before a trial:

- Current generated fixture defaults to 500 files, which is not suitable for first workflow validation.
- Current verifier is loose and does not check exact expected mutations.
- Current verifier active-file check appears out of sync with the generator manifest shape: generator records active files as `{ path }`, while verifier reads `af.dir` and `af.filename`.
- Current generator policy notes say the Shared Drive fixture is not fully aligned with scale and policy requirements.
- Current verifier does not validate `cleanup-log.csv` rows against manifest expected mutations.
- Current verifier does not verify file content preservation after moves.

## Final Recommendation

Proceed next with a design-limited Shared Drive Cleanup fixture using the existing architecture unchanged.

The first implementation should be intentionally small and deterministic: 8 source files, exact manifest expectations, workflow policy metadata, no workspace policy artifact, and strict verifier checks over mutations, content preservation, and replay evidence.
