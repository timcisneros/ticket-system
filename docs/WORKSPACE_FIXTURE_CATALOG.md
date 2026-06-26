# Workspace Fixture Catalog

## Purpose

r1.15 adds deterministic workspace fixtures as substitutes for business targets that are not connected yet. They are demo and test environments, not product data, production seeds, or examples of customer records. The final product is expected to operate against customer-owned targets through a stable target-provider boundary; these fixtures exist so capability and safety can be tested before that integration work begins.

The catalog lives in `fixtures/workspace-catalog/fixtures.json`. Generated workspaces are intentionally excluded from the repository.

## Size Classes

- **Small**: 5-20 files and folders. Intended for manual inspection, fast tests, and bounded demonstrations.
- **Medium**: 100-1,000 files and folders. Intended for nested traversal, scoped search, target metadata, noisy-input, and mutation-zone tests.
- **Large**: thousands of deterministic nested entries in full mode. Intended for bounded snapshots, truncation, listing limits, content hashing, and performance assumptions without large committed files. Test mode keeps each large fixture over 200 entries while reducing checkpoint cost.

## Domain Coverage

| Size | Fixture | Domain |
| --- | --- | --- |
| Small | `legal-intake-small` | Legal intake |
| Small | `vendor-compliance-small` | Vendor compliance |
| Small | `customer-support-small` | Customer support |
| Medium | `shared-drive-cleanup-medium` | Shared-drive cleanup |
| Medium | `billing-reconciliation-medium` | Billing reconciliation |
| Medium | `contract-packet-prep-medium` | Contract packet prep |
| Large | `status-reporting-large` | Status reporting |
| Large | `compliance-digest-large` | Compliance digest |

Every catalog entry declares its target structure, expected useful files, distracting files, protected examples, allowed and forbidden mutation zones, expected output artifacts, representative tickets, deterministic verification expectations, blocked-correctly cases, and demo narrative.

## Generation

The generator requires an explicit output directory and never reads provider configuration or uses the network:

```sh
node scripts/generate-workspace-fixtures.js --out /tmp/workspace-fixtures --all
node scripts/generate-workspace-fixtures.js --out /tmp/legal-intake --fixture legal-intake-small
node scripts/generate-workspace-fixtures.js --out /tmp/medium-workspaces --size medium
node scripts/generate-workspace-fixtures.js --out /tmp/checkpoint-fixtures --all --test-mode
```

Generation uses fixed identifiers, dates, filenames, and content. Repeated generation into separate directories produces the same file list and content hashes. The generator refuses the repository root, tracked runtime data, normal/demo workspace roots, and an existing fixture destination. It writes only below the supplied output root.

Each generated fixture includes `fixture-manifest.json` with fixture identity, size class, generation mode, fixed capture time, file and directory counts, a source-content hash, mutation zones, and expected artifacts. Expected output artifacts are declared but not pre-created.

## Target Provider Relationship

r1.14 formalized the local workspace as the first `TargetProvider`. r1.15 does not alter that provider. Generated fixture directories can be supplied as isolated local workspace roots in future tests, giving target identity, bounded snapshot metadata, read receipts, and mutation receipts a realistic tree to operate against.

The fixtures do not make replay safe for external connectors. They model local filesystem resources only and do not define remote ids, remote consistency, provider idempotency, or connector error semantics.

## Verification

`node scripts/workspace-fixture-catalog-test.js` verifies:

- catalog schema, unique ids, required fields, eight-domain coverage, and the 3/3/2 size-class split;
- every representative ticket maps to expected artifacts or a declared blocked-correctly case;
- useful, noisy, and protected example paths are generated;
- small and medium entry counts stay within their class bounds;
- bounded large generation remains over 200 entries, while full-mode targets exceed 1,000;
- generated paths remain inside the requested output root and use text-only formats;
- repeated generation has identical paths and content hashes;
- unknown fixture ids and tracked runtime output paths fail closed.

The test uses temporary directories and is part of the release checkpoint.

## Future Scenario Contracts

r1.16 business-scenario verification contracts can reference catalog fixture ids, representative ticket ids, expected artifacts, mutation zones, and blocked-correctly case ids. Scenario contracts should generate a fresh fixture, run through the normal ticket and target-provider path, and verify both requested artifacts and preserved forbidden sources. They should not special-case fixture behavior in the runtime.

## Non-Goals

r1.15 includes no real connector, customer data, production seeding, new autonomy, ambient watcher, model routing, workflow builder, rich UI, or runtime behavior change. It does not replace the existing deterministic demo or the historical evidence-corpus fixture tooling.
