# Business Scenario Verification Contracts

## Purpose

r1.16 defines deterministic scenario contracts over the r1.15 workspace fixture catalog. The contracts state what a future ticket run must produce, what source material must remain unchanged, where mutation is allowed, which requests must be blocked, and which target-provider evidence must exist.

The fixtures and contracts are demo, test, and business-scenario substitutes. They are not production customer data. The final product is expected to operate on customer-owned targets through stable target providers; these contracts make capability and safety expectations reviewable before real connectors or customer targets exist.

The contract catalog is `fixtures/workspace-catalog/scenario-contracts.json`.

## Coverage

The catalog contains 16 contracts:

- eight `artifact_success` contracts, one for every r1.15 fixture;
- eight `blocked_correctly` contracts, one for every fixture;
- all eight domains and all small, medium, and large size classes.

Artifact-success contracts require declared output files under the fixture's allowed mutation zones while preserving protected and forbidden sources. Blocked-correctly contracts require authority-denial evidence, no workspace mutation, unchanged protected content, and no compensating output artifact.

## Contract Shape

Each contract identifies:

- `fixtureId` and `representativeTicketId` from `fixtures.json`;
- objective, domain, size class, and contract kind;
- inherited allowed and forbidden mutation zones;
- required artifacts and deterministic artifact checks;
- source-preservation checks;
- evidence and target-provider checks;
- expected ticket and run outcomes;
- verification notes and explicit non-goals.

Blocked contracts also identify the fixture's `blockedCorrectlyCaseId` and concrete protected `blockedPath`.

## Check Vocabulary

The schema intentionally uses a small declarative vocabulary. It is not a policy DSL or runtime verification engine.

Artifact checks:

- `fileExists`
- `fileContains`
- `csvHasHeader`
- `jsonHasField`
- `markdownHasHeading`
- `pathUnderAllowedZone`
- `pathDoesNotExist`

Source-preservation checks:

- `fileUnchanged`
- `pathDoesNotExist`
- `noMutationUnderForbiddenZone`
- `noMutationUnderProtectedPath`
- `noUnexpectedSourceMutation`

Evidence checks:

- `mutationReceiptsPresent`
- `readReceiptsPresent`
- `workspaceOperationEventsPresent`
- `authorityDeniedEventPresent`
- `replaySnapshotPathPresent`
- `noWorkspaceMutation`

Target-provider checks:

- `targetIdPresent`, currently expecting `local-workspace`
- `targetKindPresent`, currently expecting `localWorkspace`

These names define future deterministic assertions. r1.16 validates the declarations and fixture preconditions only; it does not alter current verification, authority, triage, ticket, or run behavior.

## Static And Dry-Run Validation

Run:

```sh
node scripts/business-scenario-contracts-test.js
```

The test validates all fixture and ticket references, exact mutation-zone inheritance, artifact placement, blocked-case linkage, allowed check vocabulary, evidence requirements, target identity, and milestone non-goals. It generates every fixture in `--test-mode` under a temporary directory and confirms that useful, distracting, and protected inputs exist, expected artifacts are absent, artifact parent directories exist, and blocked paths are present and forbidden.

The r1.15 `workspace-fixture-catalog-test.js` remains responsible for repeated-generation file-list and content-hash determinism. r1.16 relies on that maintained checkpoint test instead of duplicating the same generation twice.

The scenario contract test is included in `npm run checkpoint:release`.

## Future Use

Future r1.17/r1.18 work can use these declarations to prove run, evidence, and authority closure through the normal ticket and local target-provider path. A future harness can capture source hashes, execute a ticket without a real provider where deterministic execution support exists, and evaluate the declared artifact, preservation, outcome, receipt, event, and replay checks.

That future work should consume the contracts rather than encode fixture-specific exceptions in runtime code. External connector semantics require a separate stable contract and are not implied by these local fixture scenarios.

## Non-Goals

r1.16 makes no runtime behavior change and adds no connector, customer data, Work Context, watcher, ambient behavior, model routing, workflow builder, rich UI, scheduler behavior, template behavior, triage behavior, auto-retry behavior, or new verification semantics.
