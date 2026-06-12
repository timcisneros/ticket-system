# Gap Analysis: Where S1–S4 Disappear from the Runtime Lifecycle

Date: 2026-06-11
Scope: existing substrate only, observed evidence only. No proposals.
Companion documents: `docs/FAILURE_TAXONOMY.md`, `anchored-summary.md` (terminal-path census).

## 1. What currently causes a run to FAIL

Every terminal-failure path is structural/runtime. The census (`anchored-summary.md`)
counts 39 paths in four groups: boundedness budgets (6), authority/security (10),
implementation-convenience errors (14), truthfulness protection (9). Observed in
the wild across this record:

| Code | Kind | Observed instances |
|---|---|---|
| WORKSPACE_WRITE_CONFLICT | invalid_action | runs 7, 9, 22, 23, 25, 27, 42, 43 |
| WORKSPACE_FS_ENOENT | workspace_error | runs 28, 34, 35 |
| RUN_LIMIT_EXCEEDED | timeout | runs 29, 30 (gemma3 agent) |
| OPENAI_HTTP_ERROR | provider_error | 6 runs (retrospective, quota outage) |

**No path inspects business content.** A run cannot fail because a disposition is
wrong, a rule was misapplied, or an output contradicts a policy. Failure is the
exclusive province of S5.

## 2. What currently causes a run to COMPLETE

A workflow run completes when its actions execute to `stop` without a terminal
error. The gates an output passes on the way, in lifecycle order:

1. **Parse gate** — model response must be parseable JSON (`json_object` format).
   Catches malformed output (an S5 path). Content unexamined.
2. **Schema gate** — `outputSchema` keys are template-substituted into later
   actions. No validation of values; a missing or empty field substitutes
   silently.
3. **Write gate** — `writeFile` accepts any string, including empty.
4. **Terminal status** — reached `stop` ⇒ `status: completed`.
5. **Postcondition check** — `completeRunPostconditionCheck` (server.js:4680)
   executes only AFTER status is already `completed`, and on failure appends
   `run.postcondition_failed` events — **it never changes run status**. As
   deployed, every business workflow declares `fileExists` checks only.
6. **Run evaluation** — `buildRunEvaluation` aggregates events and artifact
   presence. Its own comment states the boundary: deliverables exist, "NOT that
   their content/outcome is correct."

## 3. Which observed S1–S4 failures would have appeared as completed runs

**All of them.** Every business-correctness failure in the entire record reached
`status: completed` (or would have, where the instance ran outside the engine):

| Observed failure | Category | Run status at the time |
|---|---|---|
| vendor baseline 8–10 (duplicate/subsidiary/tier/temporal/multi-cert) | S1 | completed; caught only by offline `fixture-verifier` manifest comparison |
| vendor-041/049 misdispositions | S2 | **10 of 12 adversarial runs completed** (runs 8, 10–18). Runs 7 and 9 failed — for an unrelated S5 write conflict, while carrying the same S2 content error |
| SUP-2026-005/003/001 + all CS cluster failures | S1 (005 proven; siblings pending) | completed; caught by offline benchmark verifier |
| data_localization (Approve 12/12) | S1 | completed; FAIL verdict produced by the harness's own CSV-vs-manifest comparison, not the runtime |
| legal adv-006/007/008, adv-009 | S3 | direct-replay experiments; the equivalent workflow runs complete (CSV present, `fileExists` passes) |
| SUP-2026-007 manifest defect; CSV parser bug | S4 | S4 exists only where a verifier exists; production has no verifier, so S4 has **no production carrier at all** |
| This week's workload runs 24, 26 (legal/support outputs, unverified) | unknown | completed; if any disposition is wrong, nothing will ever say so |

The corollary is exact: **the classifier's production intake is `status: failed`,
and `status: failed` is reachable only by S5.** That is why prospective validation
returned 11/11 S5 — the pipeline is correct for everything it can see, and it can
see exactly one category.

## 4. The precise disappearance points

- **Disappearance point 1 — the parse gate is the only model-output gate.**
  S1–S4 errors are well-formed JSON. They pass.
- **Disappearance point 2 — terminal status is blind to content.** The S2 case is
  the sharpest demonstration: runs 7/9 carried both an S5 error (write conflict)
  and an S2 error (wrong disposition). The runtime caught the S5 and terminalized;
  the S2 in the same run was never representable.
- **Disappearance point 3 — postconditions fire after completion and cannot
  change it.** Even a failing check leaves `completed` intact; the
  `run.postcondition_failed` event's only consumer is the run-evaluation display.
  Nothing routes it anywhere.
- **Disappearance point 4 — the only content-aware judges are offline and
  fixture-bound.** `scripts/fixture-verifier.js` and the benchmark scripts compare
  outputs to manifests; manifests exist only for fixtures. Production inputs have
  no manifest, hence no disagreement signal, hence no dossier, hence no
  classification.

## 5. Dormant capacity already present in the substrate (facts, not proposals)

1. The postcondition evaluator implements four types — `fileExists`,
   `fileContains`, `jsonPathEquals`, `outputFieldEquals` (server.js:4609–4668) —
   of which deployed business workflows use only the weakest. The three
   content-bearing types are live code with zero production users.
2. `run.postcondition_failed` events are emitted, persisted, and aggregated into
   `runEvaluation`, but no consumer changes run status or feeds the
   failure-classification intake. The signal exists; it terminates in a display
   field.
3. The `verifierContract` field is declared on every business workflow and read
   at runtime solely to record that a contract *is declared* and that artifacts
   *exist* (`run.artifacts_checked`).

## Conclusion

S1–S4 do not disappear at one point; they are filtered out twice. First, the
runtime's failure vocabulary is purely structural, so business-incorrect runs
complete. Second, the only instruments that can detect business incorrectness
(manifest comparison) live outside the run lifecycle and only exist for fixtures.
Between a completed run and an offline verifier that production never invokes,
there is no surface where an S1–S4 failure is ever written down — except the
dormant postcondition/event machinery in §5, which is the only place in the
existing substrate where content-aware signals already flow and stop.
