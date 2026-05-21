# CLI Documentation for governance-kernel

This document describes the usage of the CLI tool provided by governance-kernel.

## Usage

Run the following command:

```bash
node bin/gov-check.js <project-path>
```

- `<project-path>`: Path to the project directory to check.

## Behavior

- The CLI produces a text report summarizing the checks against the supplied project.
- The report includes results for the following standard project rules:
  - README.md
  - package.json
  - LICENSE
  - src directory
  - test directory
  - docs directory

## Rule Severity Levels

Rules have severity levels which act as metadata to label the importance of the rule:

- `info`: Informational messages.
- `warn`: Warnings indicating potential issues.
- `error`: Errors indicating significant issues affecting the rule.

Importantly, the severity labeling does not change the pass/fail evaluation logic. Under current behavior:

- Any failed rule, whether marked as info, warn, or error, is considered a failure.
- The default severity level for rules is `error` unless otherwise specified.

## Text Output

- The severity of each rule failure is displayed alongside the PASS/FAIL status.
- This helps to distinguish between informational messages, warnings, and errors in the summary.

## JSON Output Mode

When using the `--json` option, the output includes severity details:

- Each rule and failure object includes a `severity` field showing the severity level.
- This allows tools consuming the JSON to differentiate between info, warn, and error results.

## Exit Code Contract

- `0` : All rules pass successfully.
- `1` : One or more rules fail or an unexpected error occurs.

Use this exit code programmatically to determine the compliance status of a project.

## --ignore Option

The CLI supports an `--ignore` option to exclude specific paths from checks:

```bash
node bin/gov-check.js <project-path> --ignore <path>
```

- `<path>` must be an exact match to the path to ignore.
- No glob or pattern matching is supported; only exact path strings trigger ignores.
- Multiple `--ignore` flags can be supplied to ignore multiple paths.
- When using `--json`, the output includes an `ignoredPaths` field listing all paths ignored during the check.

This option helps you exclude certain files or directories from governance checks explicitly.
