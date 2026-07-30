# Contributing

Issues and pull requests are welcome. Keep changes focused, preserve the repository's authority and
evidence boundaries, and include regression coverage for changed behavior.

Before submitting a change:

1. Do not include credentials, private ticket/run data, local environment files, or generated
   runtime state.
2. Run `npm run build` and the focused tests for the changed surface.
3. For runtime, persistence, release, or cross-cutting changes, run
   `TEST_DATABASE_URL='postgresql://...' npm run checkpoint:release`.
4. Explain the behavior changed, the evidence inspected, and the validation actually run.

By intentionally submitting a contribution, you represent that you have the right to submit it and
agree that it is licensed under this repository's [MIT License](LICENSE). This statement is not a
Contributor License Agreement and the project does not currently require a DCO sign-off.

Third-party code must retain its upstream notices. When production dependencies change, regenerate
`THIRD_PARTY_NOTICES.md` with `npm run release:licenses:generate` and verify it with
`npm run release:licenses`.
