# Failure-Classification Workflow (design)

Date: 2026-06-11
Status: design, validated retrospectively against every closed investigation.
Taxonomy: S1–S5, frozen (`docs/FAILURE_TAXONOMY.md`).

Goal: classify a failure into S1–S5 with confidence and remediation, systematically,
using only the discriminator protocol already validated by vendor-compliance,
legal-intake, customer-support (SUP-2026-005), and data_localization — and only
existing primitives (`readFile`, `agentStructuredOutput`, `condition`, `writeFile`,
`stop`, ordinary ticket runs for repeated trials).

---

## Inputs

| Input | Content | Source |
|---|---|---|
| `failurePath` | case id, observed output(s), expected output | verifier / manifest diff |
| `evidencePath` | the policy text used, the fixture/packet content, prior run outputs for the same input if available | replay snapshots / fixture dir |
| `verifierPath` | verifier output: typed error code or disposition mismatch detail | run record / fixture-verifier |

## Output artifact (`classification.json`)

```json
{
  "caseId": "...",
  "classification": "S1|S2|S3|S4|S5|ESCALATE",
  "confidence": "High|Medium|Low",
  "signal": "which rule fired and the evidence for it",
  "remediation": "add rule (needs intent) | disambiguate precedence | model selection | fix verifier/manifest | runtime config",
  "discriminatorRuns": "none | spec-arm | spec+model arms"
}
```

---

## The decision procedure (the workflow's policy text)

Rules apply in order; stop at the first that fires. R0 and R1a are mechanical
(no model call). R1b/R2 are one `agentStructuredOutput` call each. R3/R4 are
the only experimental stages and reuse the existing repeated-ticket-run pattern.

```
R0  Typed runtime error?
    verifier output is a runtime error code (RUN_LIMIT_*, WORKSPACE_*, AGENT_*,
    MODEL_MALFORMED_JSON, RUN_RESUME_UNSAFE, MUTATION_CONFLICT, ...)
    -> S5. Confidence High. Remediation: runtime/config. STOP.

R1a Repeat-run disagreement tally (mechanical).
    Count distinct dispositions for the same input across available runs.
    Disagreement present -> R1b. Agreement (or single run) -> R2.

R1b Cited-rule comparison (1 model call).
    For each divergent output, extract which policy rule its reason cites.
    Every divergent output cites a DIFFERENT EXISTING rule, each chain valid
    -> S2. Confidence High if >=10 repeats, else Medium.
       Remediation: one precedence/scoping line. STOP.
    Divergent outputs cite no covering rule / generic heuristics -> R2 (S1 suspect).

R2  Derivability audit, two-directional (1 model call).
    Given ONLY the policy text + the case facts, determine:
      (a) what disposition(s) the text entails,
      (b) whether the EXPECTED output is entailed,
      (c) whether the OBSERVED output is entailed.
    - expected NOT entailed, observed entailed
      -> S4 suspect if a human adjudicator would accept the observed output
         (SUP-2026-007 pattern), else S1 (oracle = unstated intent).
         S1 confidence High when the audit names the missing mapping
         (rule absent, token absent from policy vocabulary). STOP for S1;
         S4 requires the human adjudication step (R5).
    - multiple conflicting entailments -> S2 (as R1b). STOP.
    - expected uniquely entailed -> S3 candidate, proceed to R3.

R3  Spec-clarification arm (experiment: N>=20, fixed model, same fixture).
    Add a semantically neutral clarification of the already-entailed derivation.
    - Failure collapses -> reclassify S1/S2 per which edit fixed it.
      Confidence High. STOP.
    - Failure persists -> R4.

R4  Cross-model arm (experiment: original spec, strongest model).
    - Strong model correct -> S3. Confidence High.
      Remediation: model selection for this case class. STOP.
    - Strong model reproduces the observed output -> output is likely
      spec-compliant; return to R2(c)/R5 (data_localization Arm C pattern).

R5  Oracle adjudication (human).
    Observed output defensible under policy per independent review -> S4.
    Remediation: fix manifest/verifier/harness, re-audit affected conclusions.
    Otherwise -> ESCALATE (no observed instance in any investigation).
```

Confidence rubric (observed basis): **High** = signal plus a confirming
discriminator or a named missing mapping; **Medium** = signal only (e.g., <10
repeats, n<6 cross-model samples); **Low/ESCALATE** = R5 fall-through.

---

## Workflow skeleton (existing action vocabulary only)

One workflow pass executes R0–R2 (the cheap stages) and emits either a final
classification or a discriminator-request artifact for R3/R4, which run as
ordinary tickets exactly the way all four investigations ran them.

```json
{
  "id": "failure-classification",
  "policy": { "text": "<the R0-R5 procedure above>" },
  "actions": [
    { "id": "read_failure",  "action": "readFile", "saveAs": "failure" },
    { "id": "read_evidence", "action": "readFile", "saveAs": "evidence" },
    { "id": "read_verifier", "action": "readFile", "saveAs": "verifier" },
    { "id": "triage", "action": "agentStructuredOutput",
      "input": { "instruction": "Apply R0-R2 of workflow.policy.text.",
                 "input": { "failure": "{{failure.content}}",
                            "evidence": "{{evidence.content}}",
                            "verifier": "{{verifier.content}}" },
                 "outputSchema": { "classification": "string", "confidence": "string",
                                   "signal": "string", "remediation": "string",
                                   "needsDiscriminatorArms": "boolean",
                                   "armSpec": "string" } },
      "saveAs": "triage" },
    { "id": "final", "action": "condition",
      "input": { "value": "{{triage.needsDiscriminatorArms}}", "equals": false } },
    { "id": "write_classification", "action": "writeFile",
      "input": { "path": "...classification.json", "content": "{{triage}}" } },
    { "id": "write_arm_request", "action": "writeFile",
      "input": { "path": "...discriminator-request.json", "content": "{{triage.armSpec}}" } },
    { "id": "done", "action": "stop" }
  ]
}
```

R3/R4 execution and scoring reuse the already-written, already-validated
harnesses (`experiment-ambiguity-2x2.mjs`, `experiment-legal-failure-classes.mjs`,
`experiment-data-localization.mjs` are the templates: N-sample arms, preserved
prompts/policies/raw responses, first-column-anchored parsing).

---

## Retrospective validation — would this procedure have classified every closed case correctly?

| Case | Fires at | Result | Matches closed classification? | Cost |
|---|---|---|---|---|
| vendor runs 7/9 (`WORKSPACE_WRITE_CONFLICT`) | R0 | S5 | yes | 0 calls |
| vendor-041/049 | R1b (runs disagreed, each cited a valid different rule chain) | S2 | yes (2x2 confirmed) | 1 call |
| SUP-2026-005 | R1a disagreement -> R1b finds no covering rule cited -> R2: oracle tuple unreachable (no P3+Security rule, `confirm_false_alarm` token absent) | S1 | yes (Intervention Tranche confirmed 3/3) | 2 calls |
| data_localization | R1a agreement (Approve 12/12) -> R2: expected Reject not entailed (no legal-impossibility rule) | S1 | yes (arms B/D confirmed 20/20, 2/2; arm C pro reproduced baseline Approve) | 1 call |
| vendor baseline 8 (duplicate/subsidiary/temporal/multi-cert) | R2: expected dispositions not entailed pre-fix | S1 | yes (fixed by rule additions) | 1 call each |
| legal adv-006/007/008 (UTC ordering) | R2: uniquely entailed -> R3: persists (clarified, T=0) -> R4: pro solves original 5/5 | S3 | yes | ~26-46 calls |
| legal adv-009 (nested negation) | same path; R3 0/30, R4 pro 5/5 | S3 | yes | same |
| SUP-2026-007 | R2 two-directional: observed entailed, expected not -> R5 adjudication | S4 | yes | 1 call + human |
| legal adv-010/011 (latent) | R2: multiple/none entailed | S2/S1 latent | yes | 1 call |

**9/9 agreement with the closed record.** Distribution of effort: S5 free; S1/S2/S4
resolved in 1–2 model calls by the static stages; only S3 — the rarest and most
expensive class — requires experimental arms.

## Residual manual elements (observed, not designable away)

1. **R5 adjudication** — S4 by definition cannot be self-detected by the suspect verifier (SUP-2026-007 sat misclassified for 3 runs until a human read the output).
2. **Intent supply for S1 remediation** — the audit can prove a rule is missing but only a human can say what the rule should be.
3. **Harness self-defects** (the CSV parser bug) — caught by internal-consistency audits, not by this workflow; preserved raw outputs make the audit possible.
4. **Provenance discipline** — the data_localization reversal happened because an ephemeral experiment was never preserved; R3/R4 arms must always write the policy text and request bodies into the results artifact (the current harnesses do).

## Determination

Classification **can** be performed systematically. The evidence: the complete
closed record re-classifies correctly under a fixed five-rule procedure in which
the two stages that resolve ~80% of cases (R0–R2) are mechanical or single-model-call,
and the expensive experimental stages are reached only by the one class (S3) that
genuinely requires them. The procedure is expressible in the existing workflow
vocabulary with no new primitives; the discriminator arms reuse the existing
repeated-ticket pattern and existing harness scripts.
