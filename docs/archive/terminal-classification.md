# Terminal Path Classification

| # | Source | Error Code | failureKind | Category | Evidence from Code |
|---|--------|------------|-------------|----------|-------------------|
| 1 | L8395 | `WORKFLOW_NOT_AVAILABLE` | `invalid_action` | UNKNOWN | workflow not found or disabled, direct throw to outer catch L9036 |
| 2 | L8459 | `RUN_RESUME_UNSAFE` | `resume_rejected` | D | duplicate mutation or broken hash chain, resume state corruption detected |
| 3 | L8475 | `RUN_RESUME_UNSAFE` | `resume_rejected` | D | committed mutations without authority records, resume state corruption detected |
| 4 | L8491 | `RUN_LIMIT_EXCEEDED` (timeout) | undefined | A | `assertRunNotTimedOut`: `elapsedMs > maxRuntimeDurationMs` |
| 5 | L8492 | `RUN_LIMIT_EXCEEDED` (step) | undefined | A | `assertRunStepAllowed`: `currentStep >= maxExecutionSteps` |
| 6 | L8493 | `RUN_LIMIT_EXCEEDED` (model_request) | undefined | A | `assertRunModelRequestAllowed`: `currentCount >= maxModelRequestsPerRun` |
| 7 | L8564 | `MODEL_MALFORMED_JSON` | `invalid_action` | UNKNOWN | `parseModelActions` returned `parseError`, model response not valid execution JSON |
| 8 | L8577 | `RUN_INTERRUPTED` | undefined | UNKNOWN | `isRunInterrupted` returned true, throw to outer catch L9036 |
| 9 | L8651 | `RUN_LIMIT_EXCEEDED` (mutating_action) | `invalid_action` | UNKNOWN | `repeatedMutatingActionLimitViolations >= 2`, first violation warned, second terminated |
| 10 | L8714 | `OBJECTIVE_UNSUPPORTED_BY_ALLOWED_OPERATIONS` | `unsupported_objective` | D | `isUnsupportedObjectiveModelPlan` branch, model returned complete:false with no actions |
| 11 | L8721 | `RUN_LIMIT_EXCEEDED` (step) | undefined | D | `stalledResponses >= 2`, model returned complete:false with no actions twice |
| 12 | L8740 | `RUN_LIMIT_EXCEEDED` (operation) | undefined | A | `assertRunWorkspaceOperationAllowed`: `nextCount > maxWorkspaceOperationsPerRun` |
| 13 | L8747 | `RUN_INTERRUPTED` | undefined | UNKNOWN | `isRunInterrupted` returned true inside innermost try, gate L8934 |
| 14 | L8752 | `RUN_LIMIT_EXCEEDED` (timeout) | undefined | A | `assertRunNotTimedOut` (redundant in-action check), inner try → gate L8934 |
| 15 | L8760 | `RUN_LIMIT_EXCEEDED` (operation) | undefined | A | `listDirectoryCount > maxListDirectoryPerRun`, inner try → gate L8934 |
| 16 | L8769 | `RUN_LIMIT_EXCEEDED` (operation) | undefined | A | `readFileCount > maxReadFilePerRun`, inner try → gate L8934 |
| 17 | L4930 | `RUN_LEASE_REQUIRED` | undefined | B | `checkWorkspaceMutationAuthority` lease_owner check denied |
| 18 | L4938 | `WORKSPACE_PROTECTED_PATH` | undefined | B | `checkWorkspaceMutationAuthority` protected_path check denied |
| 19 | L4951 | `WORKSPACE_OWNERSHIP_VIOLATION` | undefined | B | `checkWorkspaceMutationAuthority` owned_output_path check denied |
| 20 | L4851 | `WORKSPACE_OWNERSHIP_VIOLATION` | undefined | B | `assertAllocatedOwnershipAllowsMutation` → `blockWorkspaceOwnershipViolation` |
| 21 | L5046 | `AGENT_OPERATION_DISABLED` | `invalid_action` | B | `assertAgentOperationAllowed` check, agent runtimeConfig disables operation |
| 22 | L6080 | `WORKSPACE_SENSITIVE_PATH` | `protected_path` | B | `assertAgentWorkspacePathAllowed` check, path matches sensitive application paths |
| 23 | L9081 | `WORKSPACE_OUTSIDE_ROOT` | `protected_path` | B | workspace provider `normalizeRelative` check, path outside workspace root |
| 24 | L9091 | `WORKSPACE_ABSOLUTE_PATH` | `protected_path` | B | workspace provider `normalizeRelative` check, absolute path |
| 25 | L9101 | `WORKSPACE_PATH_TRAVERSAL` | `protected_path` | B | workspace provider `normalizeRelative` check, `../` path traversal |
| 26 | L9107 | `WORKSPACE_HIDDEN_PATH` | `protected_path` | B | workspace provider `normalizeRelative` check, hidden/system path |
| 27 | L6689 | `AGENT_ACTION_MALFORMED` | undefined | UNKNOWN | `parseAgentDirectAction` check, action must be object, gate L8934 |
| 28 | L6703 | `AGENT_ACTION_UNSUPPORTED` | undefined | UNKNOWN | `parseAgentDirectAction` check, operation not in `AGENT_DIRECT_OPERATIONS`, gate L8934 |
| 29 | L6720 | `WORKFLOW_DRAFT_INVALID` | undefined | UNKNOWN | `parseAgentDirectAction` check, workflow draft args not object, gate L8934 |
| 30 | L6656 | `WORKSPACE_MALFORMED_ACTION` | undefined | UNKNOWN | `parseWorkspaceOperation` check, action must be object, gate L8934 |
| 31 | L6670 | `WORKSPACE_UNSUPPORTED_OPERATION` | undefined | UNKNOWN | `parseWorkspaceOperation` check, operation not in `AGENT_ALLOWED_OPERATIONS`, gate L8934 |
| 32 | L7504 | `MUTATION_CONFLICT` | undefined | UNKNOWN | `executeWorkspaceOperation` → `findConflictingMutation`, conflicting mutation committed, gate L8934 |
| 33 | L9190 | (none — bare `new Error`) | undefined | UNKNOWN | `readFile` path exists but is not a file, no failureKind, gate L8934 |
| 34 | L9205 | (none — bare `new Error`) | undefined | UNKNOWN | `writeFile` path exists but is not a file, no failureKind, gate L8934 |
| 35 | L9261 | (none — bare `new Error`) | undefined | UNKNOWN | `rename` source path does not exist, no failureKind, gate L8934 |
| 36 | L9265 | (none — bare `new Error`) | undefined | UNKNOWN | `rename` destination already exists, no failureKind, gate L8934 |
| 37 | L9277 | (none — bare `new Error`) | undefined | UNKNOWN | `delete` path is workspace root, no failureKind, gate L8934 |
| 38 | L7451 | (depends on OS error) | undefined | UNKNOWN | `listDirectory` non-ENOENT OS error re-thrown, no failureKind, gate L8934 |
| 39 | L9196/L9215/L9251 | (depends on OS error) | undefined | UNKNOWN | non-ENOENT OS error passes through `createStructuredWorkspaceFsError` unchanged, no failureKind, gate L8934 |
| 40 | L9000 | `RUN_LIMIT_EXCEEDED` (step) | `no_progress` | D | `noProgressResponses >= 3`, repeated inspection-only non-progress after ≥2 warning |
