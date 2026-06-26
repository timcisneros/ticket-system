# Workspace Fixture Catalog

This directory defines deterministic, business-like workspace fixtures for demos and tests. It contains catalog metadata only; generated workspaces are not committed.

`fixtures.json` is the source of truth for fixture identity, domain, size class, target structure, useful and noisy inputs, protected paths, mutation zones, expected artifacts, representative tickets, verification notes, and blocked-correctly cases.

Generate all fixtures into an isolated directory:

```sh
node scripts/generate-workspace-fixtures.js --out /tmp/ticket-system-fixtures --all
```

Generate one fixture or one size class:

```sh
node scripts/generate-workspace-fixtures.js --out /tmp/legal-fixture --fixture legal-intake-small
node scripts/generate-workspace-fixtures.js --out /tmp/medium-fixtures --size medium
```

Use `--test-mode` to bound the two large fixtures while retaining more than 200 entries each for snapshot-limit checks:

```sh
node scripts/generate-workspace-fixtures.js --out /tmp/catalog-test --all --test-mode
```

The generator refuses repository runtime roots, tracked `data/`, and existing fixture destinations. Generated files are plain text, JSON, Markdown, or CSV and contain no customer data.

Run the deterministic catalog check with:

```sh
node scripts/workspace-fixture-catalog-test.js
```
