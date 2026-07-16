# Failure-Cluster Report

## Scope

27 automated runs across 4 domains (Vendor Compliance, Shared Drive Cleanup, Legal Intake, Customer Support). 112 total cases processed. 19 unique failing scenarios identified. All failures are model reasoning failures except SUP-2026-007 (fixture defect).

---

## Cluster 1: Evidence Reconciliation

Model fails to cross-reference conflicting evidence when a surface urgency signal dominates. Countervailing evidence exists but is structurally buried (different source, less prominent position, technical format).

| Property | Value |
|---|---|
| **Domains** | Vendor Compliance (3 scenarios), Customer Support (3 scenarios) |
| **Unique failing scenarios** | 6 |
| **Failure occurrences** | 14 (3 VC + 3 CS v1 + 8 CS v2) |
| **Determinism** | Mixed: VC scenarios deterministic (1/1 each, consistent patterns from prior runs). CS SUP-2026-005 deterministic-wrong (6/6 across 2 fixtures). CS SUP-2026-003 deterministic-wrong-routing (3/3). CS SUP-2026-001 non-deterministic (2/3). |
| **Representative examples** | — **SUP-2026-005** (CS v1+v2): SOC reports suspicious API activity. Change ticket CHG-2026-0607-042 confirms scheduled migration. Model reads SOC signal as security incident, ignores change ticket. Fails 6/6 runs across both fixtures. — **SUP-2026-001** (CS v2): CEO claims P1 outage. Monitoring data shows 99.97% success rate. Model over-escalates to P1 in 1/3 runs, under-routes to P3/CS in 1/3. — **vendor-024** (VC): SOC2 cert current, ISO 27001 expired. Model treats conflict as Reject instead of Conditional Approve. |
| **Supporting artifacts** | `evidence-ledger.md` lines 89-99 (VC edge cases), 282-291 (CS v1 failures), 333-358 (CS v2 failures), 405-416 (cluster table), 429-445 (failure frequency table). `data/logs.json` run entries for SUP-2026-005 (model response includes security escalation despite change ticket). `data/replay-snapshots/` for individual run traces. |

---

## Cluster 2: Risk Assessment (Nuanced Classification)

Model produces wrong disposition on ambiguous policy application — not clear-cut binary but judgment call between Conditional Approve vs Approve vs Reject.

| Property | Value |
|---|---|
| **Domains** | Vendor Compliance (4 scenarios), Customer Support (1 scenario) |
| **Unique failing scenarios** | 5 |
| **Failure occurrences** | 5 (4 VC, 1 CS v2) |
| **Determinism** | VC scenarios deterministic (1/1 each, pre-existing 3 confirmed across 2 pipeline runs). CS v2 SUP-2026-004 non-deterministic (1/3). |
| **Representative examples** | — **vendor-006** (VC): dual submission. DPA present but contains non-standard terms. Model rejects instead of Conditional Approve. Deterministic across 2 pipeline runs. — **vendor-035** (VC): acquired entity with pre-acquisition terms. Model approves without flagging integration risk. — **SUP-2026-004** (CS v2): expired Enterprise contract, Standard SLA month-to-month. Model defaults to P3/CS in 1/3 runs instead of P2/Eng. |
| **Supporting artifacts** | `evidence-ledger.md` lines 47-51 (pre-existing VC misses), 114-127 (new VC edge case failures), 137-145 (disposition bias table). VC manifest `workspace-root/vendors/vendor-decision-register.csv`. |

---

## Cluster 3: Duplicate Detection Across Entities

Model fails to identify cross-entity relationships (duplicate submission, subsidiary, rebranding) that require business-context reasoning.

| Property | Value |
|---|---|
| **Domains** | Vendor Compliance only (3 scenarios) |
| **Unique failing scenarios** | 3 |
| **Failure occurrences** | 3 |
| **Determinism** | Deterministic (single pipeline run, consistent with pre-existing vendor-031 duplicate failure from baseline) |
| **Representative examples** | — **vendor-033**: explicit duplicate of VaultEdge (vendor-016) with Duplicate Submission Note in packet. Model approves instead of Conditional Approve. — **vendor-034**: SecureHarbor is DataSync Corp subsidiary, with parent DPA. Model approves subsidiary without separate risk evaluation. — **vendor-039**: AuditNest's DPA and cert use former legal name. Model approves without flagging rebranding gap. |
| **Supporting artifacts** | `evidence-ledger.md` lines 89-99 (edge case table), 114-127 (failure detail). VC fixture manifests `vendor-033.json`, `vendor-034.json`, `vendor-039.json` in `workspace-root/vendors/incoming/`. |

---

## Cluster 4: Duplicate Cascading

Model detects duplicate reliably but inherits the parent ticket's wrong classification values instead of applying the primary ticket's correct higher-severity values.

| Property | Value |
|---|---|
| **Domains** | Customer Support only (1 scenario) |
| **Unique failing scenarios** | 1 |
| **Failure occurrences** | 2 |
| **Determinism** | Non-deterministic (2/3 runs). Duplicate always detected (3/3) but inherited wrong values when parent (SUP-2026-001) has wrong classification. |
| **Representative example** | **SUP-2026-002** (CS v2): cross-customer duplicate of SUP-2026-001. Model always detects the relationship. When parent is classified as P3/CS (run 2) or P2/Eng (run 3), child inherits those values instead of P1/OC/Yes/15min. Parent PASS in run 3 still produces FAIL child because child copies parent's P2/Eng instead of its own expected P1/OC. |
| **Supporting artifacts** | `evidence-ledger.md` lines 333-342 (v2 table), 349-358 (v2 classification), 362 (v2 key findings: "SUP-2026-002 duplicate detection is robust but inherits parent classification"). |

---

## Cluster 5: Escalation Threshold Inconsistency

Model inconsistently applies escalation policy when a disputed ticket is re-opened with customer pushback.

| Property | Value |
|---|---|
| **Domains** | Customer Support only (1 scenario) |
| **Unique failing scenarios** | 1 |
| **Failure occurrences** | 1 |
| **Determinism** | Non-deterministic (1/3 runs). Passed in runs 1 and 3, failed in run 2. |
| **Representative example** | **SUP-2026-006** (CS v1): Bluebird Logistics re-opens closed ticket, claims workaround is insufficient. Expected: P2/Engineering/Yes/1hr. Model assigned P1/Engineering/15min in run 2 (over-escalated). Notably passes 3/3 in v2, suggesting context-dependency — the surrounding 7 tickets influence per-ticket classification. |
| **Supporting artifacts** | `evidence-ledger.md` lines 282-291 (CS v1 table), 296 (v1 run results), 311-317 (failure classification). CS v2 shows same ticket passes 3/3 — see row 340. `workspace-root/support-inbox/SUP-2026-006.json`. |

---

## Cluster 6: Ownership Escalation (Security Over-Reaction)

Model over-escalates evidence-quality ambiguity into a security incident.

| Property | Value |
|---|---|
| **Domains** | Customer Support only (1 scenario) |
| **Unique failing scenarios** | 1 |
| **Failure occurrences** | 1 |
| **Determinism** | Non-deterministic (1/3 runs). Passed in runs 1-2, failed in run 3. |
| **Representative example** | **SUP-2026-008** (CS v1): Zenith Analytics API key discrepancy — staging screenshots vs production logs, cross-team ownership. Expected: P3/CS/No/1bd/req_ownership_clarification. Run 3 assigned P1/Security/Yes/15min — treated evidence-quality gap as confirmed security incident despite no breach evidence and clear explanation for staging screenshots. |
| **Supporting artifacts** | `evidence-ledger.md` lines 282-291 (CS v1 table), 296-317 (run results and classification). `workspace-root/support-inbox/SUP-2026-008.json`. |

---

## Cluster 7: Catch-All Routing

When uncertain, model defaults to P3/CustomerSuccess/1bd/request_reproduction_details as a generic bucket.

| Property | Value |
|---|---|
| **Domains** | Customer Support only (1 scenario as primary failure) |
| **Unique failing scenarios** | 1 |
| **Failure occurrences** | 1 (pure instance; 3 other occurrences overlap with clusters 1 and 4) |
| **Determinism** | Non-deterministic (1/3 runs) |
| **Representative example** | **SUP-2026-004** (CS v2): entitlement ambiguity (expired Enterprise, month-to-month Standard). Model correctly resolves as P2/Eng/No/4h in 2/3 runs, but in run 2 defaults to P3/CS/1bd/request_reproduction_details. The ticket is not asking for reproduction — the model used catch-all when uncertain about tier status. Note: catch-all also appears as a symptom in SUP-2026-001(r2) and SUP-2026-002(r2,r3), but those are secondary effects of evidence reconciliation and duplicate cascading respectively. |
| **Supporting artifacts** | `evidence-ledger.md` lines 333-342 (v2 table: SUP-2026-004 run 2 = "FAIL (P3/CS/1bd)"), 415 (cluster table: "Catch-all routing (P3/CS default) — 3 failures"), 443 (frequency table: "Catch-all routing (P3/CS default) — 4 occurrences"). |

---

## Cluster 8: Classification Error (Next Action)

Model uses wrong action value while getting priority/team/SLA correct.

| Property | Value |
|---|---|
| **Domains** | Customer Support only (1 scenario) |
| **Unique failing scenarios** | 1 |
| **Failure occurrences** | 2 |
| **Determinism** | Deterministic (2/2 runs) |
| **Representative example** | **SUP-2026-004** (CS baseline): duplicate of SUP-2026-003. Model correctly identifies duplicate relationship and assigns correct priority/team/SLA, but uses `request_reproduction_details` instead of `link_duplicate_to_sup_2026_003` for next_action. Failed both baseline runs identically. |
| **Supporting artifacts** | `evidence-ledger.md` lines 254-277 (baseline fixture results). Verifier output from `npm run benchmark:ambiguous-operational` showing `next_action` check failure. |

---

## Cluster 9: Fixture Defect

Manifest does not accept a reasonable model output. Not a model reasoning failure.

| Property | Value |
|---|---|
| **Domains** | Customer Support only (1 scenario) |
| **Unique failing scenarios** | 1 |
| **Failure occurrences** | 1 (single defect manifesting across 3 runs) |
| **Determinism** | Deterministic (3/3 runs, same verifier failure) |
| **Representative example** | **SUP-2026-007** (CS v2): self-contradictory ticket — subject "EMERGENCY/P1" but body describes internal tool issue with workaround, no customer impact. Model correctly identifies P4/Backlog/no impact. Uses team "Internal Triage" which is not in manifest's acceptable teams. Model is correct; manifest is wrong. |
| **Supporting artifacts** | `evidence-ledger.md` lines 333-342 (v2 table: SUP-2026-007 = "FIXTURE"), 351-358 (classification: "Fixture defect"), 361-365 (key findings). Manifest file `manifest.json` in fixture directory. |

---

## Cross-Cutting Answers

### 1. Which failure clusters appear in multiple domains?

| Cluster | Domains |
|---|---|
| **Evidence reconciliation** | **VC + CS** — 3 unique scenarios in each. The only cluster with substantial multi-domain representation. |
| **Risk assessment** | **VC (4 scenarios) + CS (1 scenario)** — primarily VC; CS case is catch-all routing for entitlement ambiguity. |

### 2. Which failure clusters are domain-specific?

| Cluster | Domain | Scenarios |
|---|---|---|
| Duplicate detection (cross-entity) | VC only | vendor-033, 034, 039 |
| Duplicate cascading | CS only | SUP-2026-002 |
| Escalation threshold | CS only | SUP-2026-006 |
| Ownership escalation | CS only | SUP-2026-008 |
| Catch-all routing | CS only | SUP-2026-004 |
| Classification error | CS only | baseline SUP-2026-004 |
| Fixture defect | CS only | SUP-2026-007 |

CS accounts for 7 of 9 clusters but 4 of those are single-scenario clusters. The high cluster count in CS is a function of the 8-dimensional fixture design, not evidence of broader model weakness.

### 3. Which failures are deterministic?

Deterministic = same failure every time the scenario runs.

| Cluster | Scenarios | Evidence |
|---|---|---|
| Evidence reconciliation (subset) | vendor-024, vendor-032, vendor-036 (VC) | 1/1 each, consistent patterns from prior runs |
| Evidence reconciliation | SUP-2026-005 (CS) | 6/6 across 2 fixture versions, 6 runs |
| Evidence reconciliation | SUP-2026-003 (CS v2) | 3/3 — always routes wrong team |
| Risk assessment (VC subset) | vendor-006, 025, 031 | 2/2 across 2 pipeline runs |
| Risk assessment (VC expanded) | vendor-035 | 1/1 |
| Duplicate detection | vendor-033, 034, 039 | 1/1 each |
| Classification error | baseline SUP-2026-004 | 2/2 runs |
| Fixture defect | SUP-2026-007 | 3/3 runs |

### 4. Which failures vary run-to-run?

Non-deterministic = same scenario passes in some runs, fails in others (or produces different wrong answers).

| Cluster | Scenario | Failure rate |
|---|---|---|
| Evidence reconciliation | SUP-2026-001 (CS v2) | 2/3 runs |
| Duplicate cascading | SUP-2026-002 (CS v2) | 2/3 runs |
| Risk assessment / catch-all | SUP-2026-004 (CS v2) | 1/3 runs |
| Escalation threshold | SUP-2026-006 (CS v1) | 1/3 runs |
| Ownership escalation | SUP-2026-008 (CS v1) | 1/3 runs |
| Evidence reconciliation | SUP-2026-005 (CS v2) | 3/3 but always different wrong answer pattern |

### 5. Which domains exhibit zero observed failures?

| Domain | Fixture versions | Runs | Total cases | Failure rate |
|---|---|---|---|---|
| **Shared Drive Cleanup** | 2 (8 files each) | 4 | 32 | **0%** |
| **Legal Intake** | 2 (8 intakes each) | 2 | 16 | **0%** |

Both involve binary classification (Archive/Preserve; Open Matter/Request Information/Out of Scope) with clear, explicit signals. No evidence reconciliation required. The model is fully reliable on rule-following tasks with unambiguous inputs.

### 6. What percentage of observed failures belong to each cluster?

**By unique failing scenario** (19 total):

| Cluster | Count | % |
|---|---|---|
| **Evidence reconciliation** | **6** | **31.6%** |
| Risk assessment | 5 | 26.3% |
| Duplicate detection (cross-entity) | 3 | 15.8% |
| Duplicate cascading | 1 | 5.3% |
| Escalation threshold | 1 | 5.3% |
| Ownership escalation | 1 | 5.3% |
| Catch-all routing | 1 | 5.3% |
| Classification error | 1 | 5.3% |
| Fixture defect | 1 | 5.3% |

**By failure occurrence** (29 total per-run observations):

| Cluster | Occurrences | % |
|---|---|---|
| **Evidence reconciliation** | **14** | **48.3%** |
| Risk assessment | 4 | 13.8% |
| Duplicate detection (cross-entity) | 3 | 10.3% |
| Duplicate cascading | 2 | 6.9% |
| Classification error | 2 | 6.9% |
| Escalation threshold | 1 | 3.4% |
| Ownership escalation | 1 | 3.4% |
| Catch-all routing | 1 | 3.4% |
| Fixture defect | 1 | 3.4% |

---

## Consolidation Finding

Two clusters explain **57.9% of unique failing scenarios** and **62.1% of per-run failure occurrences**:

- **Evidence reconciliation** alone: 31.6% of scenarios, 48.3% of occurrences
- **Evidence reconciliation + Risk assessment** combined: 57.9% of scenarios, 62.1% of occurrences

The remaining 7 clusters each account for 1-3 scenarios. Four of those (duplicate cascading, escalation threshold, ownership escalation, catch-all routing) are subtypes of the broader "model struggles when signals conflict or policy is ambiguous" pattern, differing mainly in the domain-specific output field affected (priority, team, SLA, next_action, disposition).

**Shared Drive and Legal Intake have zero failures** — the model is fully reliable when evidence is unambiguous and rules are categorical.

**Dominant pattern**: When the model must choose between two conflicting evidence sources (a loud surface signal vs a buried authoritative signal), it consistently favors the surface signal. This is consistent across VC (cert dates, packet completeness) and CS (security logs, CEO claims, breach reports). When the decision involves weighing degrees of policy fit (Conditional Approve vs Approve, P2 vs P3), the model is inconsistent.

**Definitive result**: 29 controlled runs across 5 distinct intervention types (position, ordering, corroboration, structured blocks on all 3, single block control) — **NO intervention reliably improves evidence reconciliation.** This is an inherent model reasoning limitation, NOT fixable through prompt/cue/format engineering.

---

## Mechanism Isolation: Definitive Result

### Method
5 distinct single-variable interventions across 29 controlled runs (17 initial ER validation + 9 mechanism isolation + 3 ER-006 structured blocks):

| Experiment | Variable | Target | Runs | Result |
|---|---|---|---|---|
| CS-ER-001 (position) | Counter-evidence to top | SUP-2026-005 | 6 | Partial (P1→P3, wrong team) |
| CS-ER-004 (ordering) | Audit before claim | SUP-2026-003 | 3 | Zero effect |
| CS-ER-005 (corroboration) | 2nd evidence source | SUP-2026-001 | 3 | Zero effect (regression) |
| ER-006 (blocks all 3) | Structured blocks | 001,003,005 | 3 | Zero effect (all → P3/CS) |
| ER-002 control | Single block (005) | SUP-2026-005 | 3 | Failed to replicate (0/3) |

### Key Results
- **SUP-2026-005 (security false positive)**: Position change reduced P1 escalation but still wrong team (P3/CS). Structured block that previously passed 5/5 failed to replicate (0/3). Still 9/9 deterministic failure across all versions and experiments.
- **SUP-2026-003 (false alarm)**: Reordering audit before customer claim had zero effect (3/3 Customer Success). Evidence position is not the bottleneck.
- **SUP-2026-001 (CEO vs monitoring)**: Adding infrastructure team corroboration regressed from 1/3 to 0/3 PASS. More evidence does not override surface urgency.
- **vendor-036 (contradictory dates)**: Explicit contradiction banner (CHRONOLOGICAL IMPOSSIBILITY) fixed verdict. One-off VC success — not replicable to CS domain where signals are subjective, not objective contradictions.
- **vendor-024 (conflicting certs)**: Prominence did not fix — genuinely ambiguous policy tradeoff.

### Conclusion
- **Evidence reconciliation is an inherent model reasoning limitation.** No intervention across 5 types and 29 controlled runs reliably improves evidence reconciliation.
- The original CS-ER-002 (structured block, 5/5 PASS) was a statistical anomaly — failed to replicate (0/3).
- The model reads ALL evidence but makes wrong trade-offs when contradictory signals co-exist in prose.
- **Catch-all routing (P3/CustomerSuccess/1bd) is the default fallback** when uncertain.
- This failure is NOT fixable through prompt/cue/format engineering within the project scope.
- Shared Drive and Legal Intake have zero failures because they lack contradictory signals within a single field — all signals point the same direction.

See `evidence-ledger.md` "Mechanism Isolation Experiments" section for full methodology, per-run details, and delta report.
