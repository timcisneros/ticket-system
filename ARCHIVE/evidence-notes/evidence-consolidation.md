# Evidence Consolidation Report

## Data Sources

27 automated runs across 4 domains, 2 fixture versions (VC, SD, LI), 2 expanded CS fixtures. 19 unique failing scenarios identified from 112 total cases.

---

## 1. Failure Clusters

**Evidence reconciliation** (conflicting/countervailing signals, buried counter-evidence):
- VC: vendor-024 (conflicting certs), vendor-032 (incomplete packet), vendor-036 (contradictory dates)
- CS v1+v2: SUP-2026-005 (security false positive, 6/6 across both fixtures), SUP-2026-001 (CEO claim vs monitoring, 2/3), SUP-2026-003 (breach claim vs audit, 3/3)
- 6 unique failing scenarios

**Risk assessment** (nuanced classification, approval bias):
- VC: vendor-006 (dual submission → Reject instead of Conditional Approve), vendor-025 (incomplete → Reject instead of Conditional Approve), vendor-031 (duplicate → Approve instead of Conditional Approve), vendor-035 (acquisition → Approve instead of Conditional)
- CS v2: SUP-2026-004 (entitlement ambiguity → catch-all routing)
- 5 unique failing scenarios

**Duplicate detection across entities** (fails to identify cross-entity relationship):
- VC: vendor-033 (duplicate submission), vendor-034 (subsidiary), vendor-039 (renamed entity)
- 3 unique failing scenarios

**Duplicate cascading** (detects duplicate but inherits parent's wrong classification):
- CS v2: SUP-2026-002 (2/3 runs, always detected as dup but wrong inherited values)
- 1 unique failing scenario

**Escalation threshold inconsistency**:
- CS v1: SUP-2026-006 (1/3 runs, model inconsistent P1 vs P2 on re-opened dispute)
- 1 unique failing scenario

**Ownership escalation** (over-escalates ambiguity to security incident):
- CS v1: SUP-2026-008 (1/3 runs, evidence-quality ambiguity escalated to P1/Sec)
- 1 unique failing scenario

**Catch-all routing** (P3/CustomerSuccess/1bd generic bucket when uncertain):
- CS v2: SUP-2026-004 (1/3 runs, entitlement ambiguity → default routing)
- 1 unique failing scenario (overlaps with risk assessment; isolated here as pure catch-all)

**Classification error** (next_action mismatch):
- CS baseline: SUP-2026-004 (2/2 runs, `request_reproduction_details` instead of `link_duplicate`)
- 1 unique failing scenario

**Fixture defect** (manifest doesn't match reasonable model output):
- CS v2: SUP-2026-007 (3/3 runs, Internal Triage team missing from acceptable teams)
- 1 unique failing scenario

---

## 2. Clusters Appearing in Multiple Domains

| Cluster | VC | CS | SD | LI |
|---|---|---|---|---|
| Evidence reconciliation | 3 scenarios | 3 scenarios | 0 | 0 |
| Risk assessment | 4 scenarios | 1 scenario | 0 | 0 |
| Duplicate detection | 3 scenarios | 0 | 0 | 0 |
| Duplicate cascading | 0 | 1 scenario | 0 | 0 |
| Escalation threshold | 0 | 1 scenario | 0 | 0 |
| Ownership escalation | 0 | 1 scenario | 0 | 0 |
| Catch-all routing | 0 | 1 scenario | 0 | 0 |
| Classification error | 0 | 1 scenario | 0 | 0 |
| Fixture defect | 0 | 1 scenario | 0 | 0 |

**Only evidence reconciliation and risk assessment appear in multiple domains.** Evidence reconciliation is the only cluster with substantial representation in both VC (3 scenarios) and CS (3 scenarios).

---

## 3. Deterministic Clusters

Clusters where every scenario fails every time it is tested:

| Cluster | Scenarios | Failure rate | Determinism evidence |
|---|---|---|---|
| Duplicate detection (cross-entity) | 3 VC vendors | 3/3, single pipeline run | Consistent across 2 pipeline runs for 3 pre-existing failures |
| Evidence reconciliation (deterministic subset) | vendor-024, 032, 036, SUP-2026-003, SUP-2026-005 | VC: 1/1 each; CS: 3/3, 3/3 | SUP-2026-005 = 6/6 across 2 fixture versions, 6 runs |
| Fixture defect | SUP-2026-007 | 3/3 (same failure every run) | Manifest error, not model-dependent |

---

## 4. Non-Deterministic Clusters

Clusters where the same scenario passes in some runs and fails in others:

| Cluster | Scenarios | Failure rate | Notes |
|---|---|---|---|
| Evidence reconciliation | SUP-2026-001 | 2/3 runs | Model sometimes correctly reads monitoring data, sometimes over-escalates CEO claim |
| Duplicate cascading | SUP-2026-002 | 2/3 runs | Always detects duplicate, but inherits parent's wrong classification when parent fails |
| Risk assessment | SUP-2026-004 (v2) | 1/3 runs | Model sometimes resolves entitlement correctly, sometimes defaults to catch-all |
| Escalation threshold | SUP-2026-006 (v1) | 1/3 runs | Same ticket content, model chooses P1 vs P2 inconsistently |
| Ownership escalation | SUP-2026-008 (v1) | 1/3 runs | Same content, model sometimes over-escalates to security |
| Catch-all routing | SUP-2026-004 (v2) | 1/3 runs | Overlaps with risk assessment non-determinism |

---

## 5. Domains with No Observed Failures

| Domain | Fixture versions | Runs | Total cases processed | Failure rate |
|---|---|---|---|---|
| **Shared Drive Cleanup** | 2 (baseline + v2) | 4 (2 each) | 32 (16 unique files × 2 runs) | **0%** |
| **Legal Intake** | 2 (baseline + expanded) | 2 (1 each) | 16 (8 unique intakes × 2 runs) | **0%** |

Both domains involve binary classification (Archive vs Preserve; Open Matter vs Request Information vs Out of Scope) with clear, unambiguous signals. The model does not fail on rule-following tasks where evidence is unconflicting and signals are explicit.

---

## 6. Percentage of All Observed Failures per Cluster

Counting each unique failing scenario once (19 total):

| Cluster | Unique scenarios | % of 19 |
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

Counting per-run failure occurrences (weighted by how often failure is observed):

| Cluster | Occurrences | % of 32 |
|---|---|---|
| **Evidence reconciliation** | **15** | **46.9%** |
| Risk assessment | 4 | 12.5% |
| Duplicate cascading | 4 | 12.5% |
| Duplicate detection (cross-entity) | 3 | 9.4% |
| Classification error | 2 | 6.3% |
| Escalation threshold | 1 | 3.1% |
| Ownership escalation | 1 | 3.1% |
| Catch-all routing | 1 | 3.1% |
| Fixture defect | 1 | 3.1% |

Note: Catch-all routing occurrences (4 total) have been redistributed to their primary clusters (SUP-2026-001 → evidence reconciliation, SUP-2026-002 → duplicate cascading) where the underlying root cause is the primary cluster, not the routing symptom. Only SUP-2026-004 remains as pure catch-all.

---

## Consolidation Finding

**Evidence reconciliation is the dominant failure pattern by both measures:**

- **31.6% of unique failing scenarios** — more than any single other cluster
- **46.9% of per-run failure occurrences** — nearly half of all observed failures
- **Only cluster with substantial representation in multiple domains** (VC and CS)
- **Includes the most reliable failure** in the test suite (SUP-2026-005: 6/6 across 2 fixtures, 6 runs)
- **Includes both deterministic** (SUP-2026-005, SUP-2026-003) **and non-deterministic** (SUP-2026-001) **sub-patterns**

The model consistently fails to reconcile conflicting evidence when a surface urgency signal (security alert, CEO outage claim, customer breach report, conflicting certification dates) dominates the evidence set and the countervailing evidence (change ticket, monitoring data, internal audit report, ISO expiration date) is structurally buried (different source, less prominent position, technical rather than narrative format).

Risk assessment is the second-largest cluster (26.3% of scenarios, 12.5% of occurrences), concentrated entirely in Vendor Compliance. This involves nuanced judgment calls (Conditional Approve vs Approve vs Reject) where policy provides guidelines but not deterministic rules.

**Two domains (Shared Drive and Legal Intake) have zero failures** — the model is fully reliable on binary classification with unambiguous signals. This confirms the failure is not general reasoning capability but specific to multi-source evidence reconciliation and nuanced categorical risk assessment.
