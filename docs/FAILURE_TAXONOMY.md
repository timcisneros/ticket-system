# Failure Taxonomy for the Execution Substrate

Date: 2026-06-10
Derivation: observed evidence only — vendor-compliance (baseline 2026-05 + adversarial corpus runs 7-18 + 2x2 ambiguity experiment), legal-intake (baseline + adversarial failure-class corpus + cross-model arm), customer-support (baseline + v1/v2 fixtures + 29 mechanism-isolation runs), plus substrate execution records (replay snapshots and the frozen point-in-time terminal-path census in `ARCHIVE/evidence-corpus/anchored-summary.md`).

Every category below has at least one observed instance. No hypothetical categories.

---

## Category S1 — Missing specification

**Definition.** The policy text does not entail any disposition for the case: no rule covers the deciding facts. The oracle answer exists only as unstated business intent.

**Detection signal.**
- With an oracle/manifest: consistent or scattered disagreement on cases where no policy line can be cited for the expected answer.
- Without an oracle: model `reason`/`policy_reference` fields cite no specific rule, cite a generic reference, or different runs cite unrelated rules. Caveat (observed): the model may fill the gap from priors *consistently* — legal `intake-adv-011` (Urgency listed as required, no disposition rule covers it) produced Request Information 62/62, masking the gap entirely. Absence of failure does not prove absence of S1.

**Remediation path.** Add the missing rule to `workflow.policy.text`. Observed: the original 8 vendor-compliance business-correctness failures (duplicate submission, subsidiary certification, renamed entity, multi-certification precedence, temporal literalism, incomplete-packet handling — vendor-006/024/025/031/032/033/034/035/036/039 cluster set) were all resolved by policy additions now visible in the vendor policy's decision and reasoning rules.

| Question | Answer | Evidence |
|---|---|---|
| A. Workflow changes fix it? | **Yes** | 8/8 vendor baseline failures fixed by policy-text additions; legal FIX_M arm 50/50 after adding the Urgency rule |
| B. Model selection fix it? | **No** | The spec does not determine the answer for any reader; gpt-5.5-pro also guessed on adv-011 (guessed consistently with intent, but that is luck, not derivation) |
| C. Human review required? | **Yes** | Only a human can supply the missing business intent for the new rule |
| D. Substrate detects automatically? | **Only with an oracle** | Fixture verifier catches it on fixtures with manifests; production postconditions check `fileExists` only — a gap-filled wrong disposition is invisible |

---

## Category S2 — Contradictory / underdetermined specification

**Definition.** The policy entails two or more defensible derivations for the same case (rule collision, missing precedence). A competent reader cannot determine a unique answer from the text.

**Detection signal.** Bimodal/multimodal disposition distribution across repeated identical runs, with each run internally coherent and citing a valid rule chain; flips survive temperature 0 (observed: vendor baseline 19/20 Reject at T=0 *and* T=1, with a persistent ~5% minority reading). The model's stated reasons name *different rules* across runs.

**Remediation path.** Disambiguate precedence in the policy text — no new rules needed, only scoping of existing ones. Observed: vendor-041/049 went from 95% Reject to 0/80 wrong dispositions with a two-line clarification (Fisher p ≈ 8×10⁻²¹); legal `intake-adv-010` collision fixed-in-advance by one precedence line (FIX_C arm 50/50).

| Question | Answer | Evidence |
|---|---|---|
| A. Workflow changes fix it? | **Yes, completely** | The 2x2 experiment: disambiguation drove both temperature arms to 100% |
| B. Model selection fix it? | **No (unreliable)** | Under the ambiguous vendor policy, gpt-4.1-mini consistently preferred the *unintended but defensible* reading; which reading a model prefers is not controllable |
| C. Human review required? | **Yes, once** | A human must declare which reading is intended; after that, none |
| D. Substrate detects automatically? | **Yes — without an oracle** | Repeat-run disagreement on identical input is machine-checkable from existing replay snapshots; no manifest needed |

---

## Category S3 — Model capability limitation

**Definition.** The spec is complete and non-contradictory — a competent human derives the unique answer — but the configured model cannot, and no wording of the same semantics fixes it.

**Detection signal.** Failure persists across: specification clarification (including explicit procedural restatement), contradiction removal, and temperature 0; the model often extracts the deciding fact correctly while routing the disposition wrong (legal adv-009: "All required fields present *despite note on jurisdiction*", 160/160 correct fact extraction in the legal corpus). Discriminator: a stronger model solves it from the *original unclarified* spec.

**Remediation path.** Model selection (observed to work), else route the case class to human review. Observed *not* to work: prompt/format/position engineering (29 customer-support mechanism-isolation runs across 5 intervention types, zero reliable improvement; legal CLAR_R clarifications left adv-009 at 0/30 and made it no better).

| Question | Answer | Evidence |
|---|---|---|
| A. Workflow changes fix it? | **No** | Legal: clarified policy + temp 0 → adv-009 0/30, adv-007 ~10%. CS: 29 controlled intervention runs, no reliable effect |
| B. Model selection fix it? | **Yes (observed)** | gpt-5.5-pro: 5/5 on nested negation, 5/5 on UTC ordering, including under the original baseline policy with no hints |
| C. Human review required? | **Only as fallback** | When the stronger model is unavailable (cost/quota) or untested for the case class |
| D. Substrate detects automatically? | **No, not alone** | A deterministic-wrong answer is indistinguishable from deterministic-right without an oracle; classification additionally requires the two discriminator arms (spec-variant, model-variant), which exist today only as experiment scripts |

---

## Category S4 — Oracle / measurement defect

**Definition.** The model's output is defensible under the policy but the verifier, manifest, or analysis harness is wrong. The failure is in the measurement system.

**Detection signal.** Deterministic verifier failure paired with a model output a human adjudicator accepts; or internal inconsistency in the measurement chain itself.

**Observed instances.**
1. SUP-2026-007: model correctly classified a self-contradictory ticket (P4/no impact); manifest lacked "Internal Triage" in acceptable teams — 3/3 "failures" were manifest defects.
2. This investigation's own CSV parser attributed rows to the wrong intake when reasons mentioned other intake ids — it manufactured a phantom gpt-5.5-pro failure and contaminated 14 of 62 vendor-007 entries (audited, corrected, parser fixed in `scripts/experiment-legal-failure-classes.mjs`).
3. Boundary case: the vendor-041/049 oracle itself was underdetermined by the baseline text — "Conditional Approve" was the author's intent, not the text's unique entailment.

**Remediation path.** Fix the manifest/verifier/harness; re-audit affected conclusions.

| Question | Answer | Evidence |
|---|---|---|
| A. Workflow changes fix it? | No — the workflow is not the broken part | SUP-2026-007 model output was already correct |
| B. Model selection fix it? | No | Same |
| C. Human review required? | **Yes** | By definition: the automated judge is the suspect, so adjudication must come from outside it |
| D. Substrate detects automatically? | **Partially** | Self-consistency audits are scriptable (the parser bug was found by one); full detection requires independent adjudication |

---

## Category S5 — Execution-substrate failure

**Definition.** The run fails for non-business reasons: budget exhaustion, authority denial, malformed output handling, workspace conflicts. Business reasoning may have been entirely correct.

**Detection signal.** Already structured: `terminalStatus: failed` + error code (`WORKSPACE_WRITE_CONFLICT`, `RUN_LIMIT_EXCEEDED`, …). The archived point-in-time census in `ARCHIVE/evidence-corpus/anchored-summary.md` recorded 39 terminal paths (6 boundedness, 10 security, 14 implementation-convenience, 9 truthfulness); current behavior must be verified from source and tests.

**Observed instances.** Adversarial vendor runs 7 and 9: `WORKSPACE_WRITE_CONFLICT` ("path was previously produced by ticket 8, run 8") — terminal failure orthogonal to classification quality.

**Remediation path.** Runtime/config (retry semantics, output-path ownership); per the standing constraint, out of scope here, but the category must exist so business-failure routing does not ingest these.

| Question | Answer |
|---|---|
| A. Workflow changes fix it? | Yes (e.g., unique output paths per run) |
| B. Model selection fix it? | No |
| C. Human review required? | No |
| D. Substrate detects automatically? | **Yes — fully, today** (typed error codes) |

---

## Non-categories (explicitly rejected after testing)

- **Sampling artifact / temperature.** Falsified as a cause: vendor baseline distribution identical at T=0 and T=1 (19/20 both); legal survivors fail at T=0. Non-determinism is a *detection signal* for S2, not a failure category.
- **"Evidence reconciliation" as an inherent-limitation category.** The CS cluster (SUP-2026-001/003/005) was previously labeled an inherent model limitation, but the two discriminators that settled vendor (spec clarification under repetition) and legal (cross-model) were **never run on it** — the 29 CS interventions varied presentation, not specification, and never varied model. Until those arms run, the CS cluster is *unclassified between S1, S2, and S3* (see table below). Its strongest member, SUP-2026-005 (change ticket overriding a SOC alert), is plausibly S1: no policy line stating that a matching change ticket downgrades a security signal has been exhibited.

---

## Classification of all observed failures

| Failure | Domain | Category | Status / evidence |
|---|---|---|---|
| vendor-006, 024, 025, 031, 032, 033, 034, 035, 036, 039 (baseline clusters 1–3) | VC | **S1** | Resolved by policy additions; user-confirmed 8/8 business failures fixed via spec changes |
| vendor-041, vendor-049 | VC adversarial | **S2** | Proven: 2x2 experiment, disambiguation → 0/80 wrong, p≈8×10⁻²¹ |
| Adversarial runs 7, 9 terminal failures | VC adversarial | **S5** | `WORKSPACE_WRITE_CONFLICT`, auto-detected |
| intake-adv-006/007/008 (UTC duplicate ordering) | LI adversarial | **S3** | Proven: survives all spec variants + T=0 on mini; gpt-5.5-pro 5/5 incl. baseline |
| intake-adv-009 (nested negation) | LI adversarial | **S3** | Proven: mini 0/30 clarified; pro 5/5 |
| intake-adv-010 (Decline/RI collision) | LI adversarial | **S2 (latent)** | No observed failure — model filled gap consistently; defect exists in text |
| intake-adv-011 (Urgency gap) | LI adversarial | **S1 (latent)** | Same — 62/62 consistent gap-fill |
| LI baseline corpus (16 cases) | LI | none | 0 failures, consistent with all categories absent |
| SUP-2026-005, -003, -001 (evidence reconciliation) | CS | **Unclassified: S1/S2/S3** | Spec-clarification and cross-model discriminators never run; prior "inherent limitation" verdict unsupported by the required controls |
| SUP-2026-002 (duplicate cascading) | CS | **Derived** | Correct duplicate detection; inherits parent SUP-2026-001's wrong values — classify and fix the parent first |
| SUP-2026-004 v2 (catch-all routing) | CS | **Unclassified: S1/S2** | Entitlement precedence (expired Enterprise vs month-to-month Standard) not shown to be specified |
| SUP-2026-004 baseline (next_action) | CS | **Unclassified: S1/S3** | Deterministic 2/2; whether policy specifies `link_duplicate` next_action unverified |
| SUP-2026-006, SUP-2026-008 (threshold flapping) | CS | **Unclassified: S2-pattern** | Run-to-run disposition flips on identical input = textbook S2 signal; discriminator not run |
| SUP-2026-007 | CS | **S4** | Proven fixture defect (manifest), model correct 3/3 |
| Phantom gpt-5.5-pro failure (ALL#1) | harness | **S4** | Parser row mis-attribution; audited and fixed |

---

## Can the substrate route failures to remediation automatically?

**Today: only S5.** Typed error codes already separate execution failures from business failures.

**Automatable from existing data, no oracle needed: S2.** Replay snapshots capture full requests; repeat-run disposition disagreement on identical input is a mechanical check, and S2's remediation (human disambiguates one precedence question) is uniquely cheap. This is the highest-value routing the substrate does not yet do.

**Requires an oracle: S1 vs S3 detection.** Both present as consistent wrong answers. The fixture verifier provides the oracle for fixtures only; production postconditions (`fileExists`) cannot see either. Given an oracle, the discriminator protocol is mechanical and was executed twice in these investigations: (1) re-run with semantically-neutral spec clarification, N≥20 — if fixed, S1/S2; (2) re-run original spec on a stronger model — if fixed, S3. Both exist as scripts (`experiment-ambiguity-2x2.mjs`, `experiment-legal-failure-classes.mjs`) but not as substrate routine.

**Never fully automatic: S4.** The judge cannot acquit itself; periodic human adjudication of verifier failures is the only observed remedy (SUP-2026-007 sat misclassified as a model failure for 3 runs until a human read the output).

**Routing decision tree (evidence-backed):**

```
terminalStatus failed with typed error code?        → S5  (auto, today)
verifier/oracle disagreement?
├─ output defensible to adjudicator?                → S4  (human)
├─ repeated runs disagree with each other?          → S2  (auto-detectable; human writes 1 precedence line)
└─ repeated runs agree, all wrong:
   ├─ neutral spec clarification fixes (N≥20)?      → S1/S2 (spec change)
   └─ persists; stronger model solves original?     → S3  (model selection)
      └─ stronger model also fails?                 → not yet observed in any investigation
```

The bottom branch is empty by observation: no failure in any of the three domains has yet survived both the spec discriminator and the model discriminator. The customer-support cluster is the only candidate population, and it has not been put through either arm.

---

## Closure addendum (2026-06-11)

- **SUP-2026-005 → S1.** Discriminator Phase A was found already executed (Intervention Tranche 1, ledger L1547-1597): §8.1 rule addition, ≥9/9 fail → 3/3 pass. Static audit confirmed the oracle tuple (P3/Security/No/1bd/confirm_false_alarm) was underivable from the attached policy.
- **data_localization → S1.** The last candidate for a failure outside S1–S5. Reconstructed discriminator run (`scripts/experiment-data-localization.mjs`, `data/experiment-data-localization-results.json`): mini/baseline Approve 12/12; **mini/+rule Reject 20/20** — the historical "survives the rule" claim (2 unpreserved runs, ledger ~L1677) failed replication; pro/baseline Approve 2/2 (the strong model reads the same spec and reaches the same "failure" — it is spec-compliant behavior, not error); pro/+rule Reject 2/2.
- **The routing tree's bottom branch remains empty.** No observed failure survives both discriminators. Taxonomy investigation closed.
