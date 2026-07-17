# Decision Memo: Objective Interpretation Direction

Recorded 2026-07-17. Context: the in-flight model contract compiler
(`ENABLE_MODEL_CONTRACT_COMPILER`, default off, branch `model-contract-compiler`) raised the
question of where objective interpretation should go.

## Decision Under Consideration

Should deterministic objective parsing (`objective-contract.js` + the compiler wiring) be
(a) extended in its current direction, (b) discarded in favor of model-driven interpretation,
or (c) repositioned under an explicit truth-hierarchy rule?

## Options

### Option A: Grow the deterministic grammar
Extend `objective-contract.js` to recognize more natural-language objective forms.

### Option B: Discard determinism for model focus
Remove the deterministic interpretation layer; let the model interpret objectives end-to-end
with only generic guardrails.

### Option C: Freeze the grammar; continue the compiler under a truth-hierarchy rule
Keep the deterministic grammar at its current narrow scope. Continue the model contract
compiler as the interpretation mechanism for everything the grammar does not recognize —
with explicit constraints on what authority each contract source can exercise.

## Known Evidence

- `docs/DIRECTION.md` truth hierarchy: facts > claims > inference; "inference that contradicts
  a fact is invalid"; "no speculative execution"; semantic density grows from operational
  pressure, not architectural design.
- Demonstrated failures caught by the deterministic layers: moving-goalpost drift (fixed via
  anchoring, validated live), near-miss deletes (exact delete-target identity), completion
  over-claiming (postcondition gates). Removing these layers re-opens demonstrated failure
  classes — the cost of Option B is not hypothetical.
- The grammar's conservative bail-out list means it covers only trivial objective forms; every
  extension increases wrong-parse risk, and a wrong deterministic parse *looks* more
  authoritative than it deserves — worse than model fallback. Cost of Option A grows with scope.
- The consolidation arc (v0.1.27–v0.1.31, closed) deliberately made the grammar a narrow pure
  module with golden parity tests. Option A would reverse a closed arc.
- As wired at the time of this memo, a **model-compiled** contract can satisfy
  `checkObjectiveContractPostcondition` and complete a run pre-model, and can influence
  hard rejections (delete-target identity, budget infeasibility). Restriction is
  security-safe (it cannot expand authority or corrupt the workspace) but **not**
  automatically truthful or operationally safe: a wrong inferred restriction can reject the
  correct target, prohibit a necessary mutation, or declare a feasible objective infeasible —
  false blocking, needless triage, failed outcomes. Monotonic restriction must not be
  mistaken for correctness.

## Unknowns

- Compiler contract accuracy on realistic objectives (no benchmark exists yet).
- Operational frequency of objectives the grammar recognizes vs. ones requiring compilation.

## Decision

**Option C**, governed by:

> **Inference may self-bind and escalate; only explicit claims, observed facts, and
> deterministic guards may produce hard outcomes.**
>
> - Deterministic grammar may translate explicitly supported objective claims into canonical
>   checks and constraints.
> - Model interpretation may restrict its own candidate plan, flag conflicts, and request
>   triage.
> - Model interpretation may not complete a run, expand authority, relax a guard, redefine a
>   confirmed claim, or create a terminal denial.
> - Completion requires postcondition evidence **independently evaluated by the applicable
>   verifier** (filesystem stat, browser evidence check, deterministic content check, or
>   authorized human confirmation). Neither a contract nor the executing model's report
>   constitutes the observed fact.
> - Provenance is never silently upgraded: corroboration and confirmation produce **new,
>   separately sourced records**, not in-place promotions.

### 1. Determinism does not itself make something a claim

A deterministic parser is repeatable, not necessarily correct. A grammar-produced contract
acquires claims-layer standing only when **all** of the following hold:

- the recognizer matches an explicitly supported form;
- operation and target identity are extracted without semantic guessing;
- canonicalization preserves exact operation/target meaning;
- parity tests cover that recognizer;
- the recognizer abstains when any required element is ambiguous.

The grammar may define **what fact to verify**. The contract alone must never constitute
completion. Example:

- Objective claim: `Create folder reports`
- Grammar contract: `operation=createFolder, target=reports`
- Observed fact: `reports` exists as a directory (established by the verifier, not asserted
  by the contract or the executing model)

The independently verified postcondition completes the objective — not the existence of the
parsed contract.

**Freezing the grammar does not grandfather existing recognizers.** Each current recognizer
must be audited against the claims-standing conditions above; any recognizer that relies on
semantic guessing must abstain or be downgraded before the compiler defaults on.

### 2. Model restrictions have soft and hard categories — and self-binding is not runtime enforcement

A model-compiled contract **may** (soft — self-binding and escalation):

- narrow the model's own proposed action set;
- mark possible target mismatches;
- identify suspected budget infeasibility;
- request clarification;
- send the ticket to structured triage;
- constrain model prompt and candidate-plan generation toward its inferred envelope.

Self-binding means the envelope may constrain **what is included in the next model prompt,
which actions the planner proposes, and whether the model asks for clarification**. It must
not be fed into ordinary runtime validation as an authoritative rejection rule: the moment
the runtime rejects an otherwise authorized action because it violates the model contract,
the inference has become a hard guard. Implementation must keep the two representations
structurally separate — e.g.

```json
{ "source": "model", "advisoryConstraints": { "...": "..." }, "authoritativeConstraints": null }
```

— never one generic `objectiveContract` field whose provenance every downstream caller must
remember to check.

A model-compiled contract may **not** (hard):

- permanently reject a valid runtime action;
- terminally block or fail a ticket;
- declare the objective infeasible;
- redefine the authoritative target;
- suppress a deterministic contract;
- prevent an operator-confirmed action.

A false model inference must end in "interpretation uncertain; human decision required,"
not "objective invalid" or "operation forbidden."

### 3. Model-initiated triage is allowed but nonjudgmental

Escalation records produced from model interpretation state uncertainty and evidence, never
conclusions:

- allowed content: interpretation uncertain; suspected mismatch; clarification required;
  proposed constraint; evidence supporting the concern;
- allowed reason code: `objective_interpretation_uncertain` (until corroborated);
- prohibited reason codes from model-only escalation: `objective_infeasible`,
  `invalid_target`, `operation_forbidden` — those labels state conclusions.

The triage transition is **non-terminal and resumable**: it preserves safety without
asserting the model is correct, and it must not consume the ticket's final failure outcome.

### 4. Authority by contract source — promotion only by new record

| Contract source | May define postcondition | May complete from verified fact | May cause hard rejection |
|---|---|---|---|
| grammar | Yes | Yes | Only through an existing deterministic guard with exact supported semantics |
| model | No; advisory proposal only | No | No |
| deterministic_corroboration | Yes, within what was independently established | Yes | Only through the corroborating guard |
| human_confirmed | Yes | Yes | Only within the confirming actor's authority and confirmed scope |

**Corroboration never upgrades a model-sourced contract in place.** It creates a separately
sourced authoritative record that references the original model proposal:

```json
{
  "source": "deterministic_corroboration",
  "derivedFrom": { "source": "model", "contractId": "..." },
  "authoritativeConstraints": { "operation": "deletePath", "target": "reports/old" },
  "corroboratingEvidenceRefs": ["..."]
}
```

Likewise, human confirmation produces a new `human_confirmed` record rather than mutating the
model contract's standing. A `source: 'model'` record remains advisory permanently — no
downstream corroboration flag may make it authoritative, which would recreate the
provenance-dependent branching this memo exists to eliminate.

The grammar supplies exact operands to **existing** deterministic guards; the parser itself
invents no new prohibition. Otherwise `objective-contract.js` quietly becomes an
authorization engine. Human-confirmed inference becoming reusable labeled evidence fits this
system; expanding the hand-written grammar does not.

## Consequences

1. The `objective-contract.js` grammar is **frozen** at its current scope. New recognizers
   require a new decision memo justified by operational pressure, and must satisfy the
   claims-standing conditions. Existing recognizers are audited against those conditions
   (no grandfathering) before the compiler defaults on.
2. Runtime enforcement (tracked as a task at the time of this memo): every hard-outcome path
   branches on contract source per the table; model-compiled contracts are carried as
   `advisoryConstraints` structurally separate from authoritative constraints; existing
   model-sourced hard blocks (delete-target identity, budget infeasibility) downgrade to
   nonjudgmental escalation; corroboration and confirmation emit new
   `deterministic_corroboration` / `human_confirmed` records with `derivedFrom` links;
   `checkObjectiveContractPostcondition` accepts grammar, deterministic_corroboration, and
   human_confirmed sources only.
3. Replay provenance for compiled contracts: `source: 'model'` plus compiler version,
   model/provider, objective hash, and the exact restrictions the contract influenced.
4. Before `ENABLE_MODEL_CONTRACT_COMPILER` defaults on, a benchmark gates it, prioritizing
   **precision and abstention over coverage** — a compiler that declines to interpret half of
   realistic objectives is preferable to one that confidently restricts 5% of them
   incorrectly. Required measures:
   - false restriction rate, false infeasibility rate, and false escalation rate (a compiler
     that hard-blocks nothing can still harm operations by sending valid tickets into triage
     constantly);
   - target-identity and operation-identity accuracy;
   - disagreement with deterministic contracts on grammar-recognized objectives;
   - stability across harmless paraphrases;
   - rate of inappropriate hard-outcome attempts;
   - calibration/confidence usefulness, if confidence is exposed;
   - headline metric: **how often would this compiler have incorrectly prevented successful
     work if its advisory result had been enforced?** — that directly tests the failure this
     memo is designed to prevent.
   The module header's parity requirement is enforced by test, not comment.
5. Model-focus investment belongs where inference is consumed as labeled inference:
   operator↔agent messaging (inbox), terminal reports, human-confirmed contracts — not in
   replacing the claims layer.

## Separation preserved

- grammar translates narrow explicit claims;
- deterministic guards enforce proven boundaries;
- verifiers establish facts;
- models propose interpretations;
- humans may confirm interpretations within their authority;
- provenance is never silently upgraded;
- uncertainty escalates rather than masquerading as truth.
