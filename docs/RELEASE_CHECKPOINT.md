# Release Checkpoint

The release checkpoint (`scripts/release-checkpoint.js`, run via `pnpm run checkpoint:release`) is
the single command that proves the build is releasable. It runs the documented checks sequentially,
prints each command, and stops on the **first** failure with a nonzero exit — failures are never
swallowed.

## What it is

- A project-wide JavaScript syntax build followed by an ordered list of deterministic test scripts
  (`CHECKPOINT_TEST_SCRIPTS`, exported from `release-checkpoint.js`).
- Before running, it **verifies every referenced test script exists on disk** and fails loudly if
  any is missing — an omission can never be silently skipped.
- The final line reports the count and elapsed time:
  `RELEASE CHECKPOINT PASSED: N/N checks in Xs`.

## What it covers

Every critical primitive has a test in the checkpoint, including: ticket timeline & authority
visibility; target-provider contract; process-template trigger / scheduled trigger / state /
disable-pause / version provenance / append-only version store / **activation durability**; Work
Context primitive & visibility; agent handoff protocol & handoff smoke loop; bounded watcher; model
provider routing; local connector contract; operational transparency; page-render regression; plus
the older substrate regressions (feasibility gate, moving-goalpost, postcondition completeness,
timeout attribution, evidence clarity, phase-contract alignment, objective-contract parity, etc.).
It also covers fail-closed startup data validation, RBAC/inline-data security, event-chain tamper and
restart continuity, internal-demo request/session hardening, and the opt-in objective compiler boundary.

The **coverage guard** (`scripts/release-checkpoint-coverage-test.js`) is itself a checkpoint test:
it asserts — without running the suite — that the checkpoint list is honest (every entry exists, no
duplicates, deterministic order, and the critical primitive tests are present). It also asserts that
additional critical tests run in the verification suite but kept out of the checkpoint count
(`triage-inbox-test.js`, `triage-resolution-test.js`, `demo-seed-test.js`) **exist on disk**.

## Expectations

- **Provider-free / network-free.** No check calls an external model/provider or the network. Some
  checks start a local Fastify server on `localhost` (normal port binding only).
- **Temp `DATA_DIR` / `WORKSPACE_ROOT`.** Server-backed tests create their own temp data and
  workspace directories and clean them up.
- **No tracked-data mutation.** Running the checkpoint mutates no tracked `data/` files and rewrites
  no tickets/runs/evidence.
- **Deterministic.** The list order is fixed and the tests are deterministic.

## How to run

```sh
pnpm run checkpoint:release
```

A **pass** means: the build loads, every listed test passed, and the checkpoint list is internally
consistent. A pass **does not** mean: the product has been exercised against a live model/provider,
or that anything has been deployed — the checkpoint is provider-free and read-only with respect to
tracked data.

## Release hygiene steps

For each release milestone:

1. **Clean tree** — `git status --short` is empty.
2. **Expected branch** — `git branch --show-current` is the milestone branch.
3. **Expected files** — `git show --stat --name-only HEAD` lists only the intended files;
   `git diff --check HEAD^ HEAD` is clean.
4. **Build** — `pnpm run build`.
5. **Checkpoint** — `pnpm run checkpoint:release` passes.
6. **Fast-forward merge only** — `git checkout master && git pull --ff-only && git merge --ff-only <branch>`.
7. **Push** — `git push origin master`.
8. **Annotated tag** — `git tag -a <milestone> -m "..." && git push origin refs/tags/<milestone>`.
9. **Delete the local branch** once merged. **Do not delete any remote branch** unless explicitly
   requested, and **do not move old tags**.

An optional, **read-only** helper `scripts/release-hygiene-check.js [tagPattern]` prints branch,
HEAD, working-tree status, `HEAD^..HEAD` file list, matching tags, and backup-branch isolation. It
**never mutates git state** (no push/tag/merge/reset/checkout) and is informational only — not part
of the checkpoint.

## Preserved backup branches

A prior reconciliation preserved three branches that hold foreign concurrent work and the original
bad-stack commit:

- `backup/local-master-with-foreign-and-r1.28`
- `backup/foreign-stack-before-r1.28`
- `backup/r1.28-commit-caec9a6`

These are **intentionally preserved and are not part of the release flow.** They must never be
merged, pushed, deleted, or moved as part of a release. The hygiene helper observes (but never
modifies) them and warns if any becomes an ancestor of `HEAD`.
