# Direction

Invariants for the system's evolution. Not a roadmap. Not a specification.

## Layer separation

- **Substrate** records operations, enforces bounds, exposes state truthfully.
- **Semantic layers** may interpret substrate data. They must never alter it.
- Substrate does not infer. Semantic layers may infer, but their output is claims, not facts.
- No semantic layer may recursively write back into the substrate without explicit operator action.

## Truth hierarchy

1. **Facts** — what the substrate recorded (operations, timestamps, error codes, file paths)
2. **Claims** — what a semantic layer derives (progression, coverage, intent, completion)
3. **Inference** — what a model produces (summaries, plans, judgments)

Lower-numbered layers override higher ones. A claim that contradicts a fact is wrong. Inference that contradicts a claim is acceptable; inference that contradicts a fact is invalid.

## Honesty constraints

- Coverage describes recorded operations, not workspace materialization. A file written in run R7 may or may not exist on disk now.
- Operational history and workspace state are separate layers. The system exposes drift truthfully (ENOENT, stat mismatch). It does not silently reconcile.
- Every surface must be honest about which layer it describes.
- Coverage uses heuristic path extraction from ticket objectives. When extraction cannot derive targets, it reports "no explicit paths extracted" — not a vacuous 0/0. This prevents semantic failure from masquerading as evidence success.

## What the system does not do

- No hidden orchestration. Every operation is operator-visible and operator-auditable.
- No autonomous semantic evolution. No layer evolves its own representation without explicit direction.
- No automatic reconstruction. The system does not infer workspace state from history.
- No speculative execution. The system does not pre-compute or cache semantic interpretations.

## How semantic density emerges

Semantic density — the richness of what the system can express and surface — emerges from operational pressure, not from architectural design. When operators repeatedly reconstruct the same information, that pressure reveals missing surfaces. Build those surfaces. Do not build surfaces speculatively.

This is not a principle of minimalism. It is a principle of operational truthfulness.

## Parser contract

The CLI parser is a mechanical transducer. It translates `argv` into a flat key-value map. It does not interpret, correct, infer, or reorder.

### Invariants

1. **Parsing is mechanical, not semantic.** No flag reads another flag's value. No flag changes meaning based on command context. The parser does not know what commands exist.

2. **Boolean flags never consume the next argument.** An explicit set of boolean flags (`api`, `json`, `help`, `h`) are recognized as boolean at parse time. The next `argv` element — whether it starts with `--` or not — is never consumed as their value.

3. **Value flags bind explicitly.** A non-boolean flag consumes the next `argv` element as its value. If the next element starts with `--` or does not exist, the flag is treated as boolean (present/true). The consuming pattern is unconditional — no heuristic skips positional args.

4. **Positional args are preserved.** Every `argv` element that does not start with `--` is collected into a positional array. No flag may absorb a positional arg. No flag may reclassify as positional.

5. **Flag order must not change meaning.** `--a --b value` and `--b value --a` produce identical `args`. `replay --api 1` and `replay 1 --api` produce identical `args.api` and `args._`.

6. **`--json` means machine-readable stdout only.** When `--json` is set, stdout must contain only valid JSON. No labels, no warnings, no ANSI, no human-readable headers. Stderr may carry non-JSON output. This invariant is enforced by regression tests.

7. **No fuzzy correction.** The parser does not correct typos, suggest alternatives, or match partial flag names. An unrecognized flag is stored as-is or silently stored as a key — never reinterpreted.

8. **No inferred targets.** No flag value is defaulted from context (e.g., inferring `--api` from the presence of a server URL). Environment variables may set defaults (`OPERC_URL`, `DATA_DIR`). These are explicit operator configuration, not inference.

9. **No hidden coercion.** Flag values are stored as strings. Numeric interpretation, boolean coercion, and default application are the responsibility of each command, not the parser. The parser does not convert `--limit 5` to `5` as a number.

10. **Syntax binds behavior; semantics do not reinterpret syntax.** If a flag is syntactically present, it is semantically present. No semantic layer may override, suppress, or reinterpret a syntactically valid flag. No command may silently ignore a flag it does not recognize — it must either use it or error.

### Enforcement

The regression tests in `scripts/test-substrate-identity.js` verify these invariants at the integration level. A failing test means the parser contract is violated, regardless of whether the output appears "correct" to a human operator. These tests protect substrate law, not convenience.
