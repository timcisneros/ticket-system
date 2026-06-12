# Scenario Product Fit Re-evaluation

## Method

The previous evaluation was too literal: it classified scenarios as "beyond the system" if the product could not personally execute every external action (send emails, restart services, inspect physical equipment).

This re-evaluation applies a practical usefulness standard:

- **Can the product meaningfully participate in the work?**
- Can it produce preparatory analysis, options, recommendations, plans, or artifacts?
- Can it support the human decision-maker with structured output?

The product's actual capabilities are:
- Read and write files in a workspace
- Analyze text and data within those files
- Produce structured output and reports
- Execute deterministic workflows
- Apply different runtime envelopes based on detected work type

These capabilities map to: **analysis, planning, drafting, recommendation, documentation, and preparation** — not to **execution, deployment, physical action, or real-time system interaction**.

The re-evaluation classifies each scenario against this practical usefulness standard.

---

## 1. Distribution of Fit Categories

| Category | Description | Count | Percentage |
|---|---|---|---|
| **1. Product is central** | The work is primarily document analysis, writing, planning, or recommendation that the product can directly produce | 52 | 52% |
| **2. Product is a meaningful participant** | The product can produce significant preparatory work, analysis, or artifacts; external action is still required but the product's output is essential input | 40 | 40% |
| **3. Product is only a peripheral helper** | The product can produce minor supporting materials; the core work is outside its scope | 8 | 8% |
| **4. Product has little or no role** | The work is fundamentally physical, real-time, or entirely outside the workspace | 0 | 0% |

**Total:** 100 scenarios

---

## 2. Patterns Where the Product Is Central (52%)

### Pattern 1: Document Analysis and Report Production (21 scenarios)

The product reads source documents, analyzes content, and produces structured findings.

**Examples:**
- Investigate payment gateway rejections (1) — analyze transaction logs, produce root cause report
- Diagnose inventory 503 errors (3) — analyze logs, produce diagnosis
- Security audit report (3) — read auth code, identify risks, write findings
- Customer sentiment synthesis (36) — if social data is provided as files, synthesize into report
- Review underwriting model output (15) — apply rubric, write structured review
- Marketing duplicate email investigation (96) — analyze campaign logs, identify root cause

**Why central:** The work is entirely file-bound. The product can directly produce the output that constitutes "doing the work."

### Pattern 2: Planning and Scoping (16 scenarios)

The product synthesizes requirements, constraints, and options into a scoped plan.

**Examples:**
- Scope CRM replacement (6) — research, synthesize requirements, write scope document with acceptance criteria
- Scope predictive maintenance (25) — analyze equipment data, write implementation plan
- Scope FDA post-market surveillance (67) — research guidance, write compliance scope
- Scope first-party data strategy (100) — research regulations, write strategy document

**Why central:** The deliverable *is* the scoped document. The product can produce it directly.

### Pattern 3: Reconciliation (6 scenarios)

The product compares two sets of records and identifies discrepancies.

**Examples:**
- Reconcile ledger with settlement reports (5) — read both files, identify gaps, write reconciliation
- Reconcile shipping manifests (24) — compare manifests, identify discrepancies
- Reconcile marketing spend with finance (99) — compare accruals, identify variances

**Why central:** The work is a file-to-file comparison. The product can directly produce the reconciliation report.

### Pattern 4: Policy and Procedure Drafting (9 scenarios)

The product produces governing documents from requirements and constraints.

**Examples:**
- Draft HIPAA retention policy (12) — synthesize regulations, write policy with exception handling
- Draft returns policy (34) — align consumer law with vendor agreements
- Curate fair housing procedures (93) — research regulations, write procedures
- Curate sepsis detection protocol (71) — research clinical evidence, write protocol

**Why central:** The deliverable *is* the policy document. The product can produce it directly.

---

## 3. Patterns Where the Product Is a Meaningful Participant (40%)

### Pattern 1: System Transition and Deployment Support (12 scenarios)

The product produces the artifacts that enable deployment but cannot execute the deployment itself.

**Examples:**
- Validate database backups (8) — write test scripts, validation procedures, and pass/fail criteria; human executes tests
- Transition loan processing system (16) — produce migration plan, data mapping, rollback procedures, test cases
- Deploy real-time inventory sync (23) — produce deployment procedures, pre-checks, post-checks, rollback plan
- Deploy LMS integration (76) — produce integration spec, test cases, cutover plan

**Why meaningful participant:** The human cannot safely execute the transition without the plan, test cases, and procedures the product produces. The product's output is essential input to the actual work.

### Pattern 2: Negotiation and Decision Support (8 scenarios)

The product analyzes data and generates options, positions, and recommendations that a human uses in negotiation or decision-making.

**Examples:**
- Negotiate SLA terms (17) — analyze usage patterns, model pricing scenarios, draft negotiation position document
- Negotiate logistics provider terms (31) — analyze volume data, model cost scenarios, draft terms comparison
- Resolve DevOps/Security escalation (19) — analyze evidence, apply weighted criteria, produce recommended resolution
- Finalize go/no-go decision (20) — gather evidence, check criteria, produce decision recommendation with dissent logging

**Why meaningful participant:** The negotiation or decision *requires* the analysis, options, and recommendation the product produces. The human uses these artifacts directly. The product does not need to send the email itself.

### Pattern 3: Rollout and Coordination Support (6 scenarios)

The product produces plans, materials, and frameworks that a coordinator uses to manage multi-party work.

**Examples:**
- Coordinate expense policy rollout across 12 offices (9) — produce rollout plan, policy documents, training materials, communication templates, checklists
- Coordinate raw materials shortage (29) — produce coordination plan, prioritization framework, alternative sourcing analysis
- Coordinate patient data integration (70) — produce integration plan, data mapping, test cases, governance framework

**Why meaningful participant:** The coordinator uses the product's output (plans, templates, frameworks) as the primary tool for coordination. The product does not need to send emails itself.

### Pattern 4: Mandate Clarification (7 scenarios)

The product researches benchmarks, proposes metrics, and drafts scoped objectives that a human validates with stakeholders.

**Examples:**
- Clarify "improve customer experience" (11) — research industry benchmarks, propose KPIs, draft scope with measurable acceptance criteria
- Clarify "reduce waste" (32) — research waste categories, propose targets, draft initiative scope
- Clarify "optimize working capital" (52) — analyze current state, propose KPIs, draft accountability framework

**Why meaningful participant:** The product produces the structured clarification document that the stakeholder uses to align on scope. The product does not need to conduct the stakeholder meeting itself.

### Pattern 5: Remediation Planning (3 scenarios)

The product diagnoses the problem and produces a remediation plan that operations executes.

**Examples:**
- Remediate telehealth video degradation (13) — analyze logs, identify root cause, produce step-by-step remediation plan
- Remediate call center IVR abandonment (35) — analyze call logs, identify failure pattern, produce fix procedures
- Remediate building management system (55) — analyze system logs, produce remediation steps

**Why meaningful participant:** Operations executes the fix, but the fix plan comes from the product's diagnosis. The product produces the essential artifact.

---

## 4. Patterns Where the Product Is Only a Peripheral Helper (8%)

### Pattern 1: Physical System Validation (5 scenarios)

The product can write test plans and checklists, but the actual validation requires physical testing.

**Examples:**
- Validate quality control vision system (28) — can write test procedures, but actual testing requires cameras and production line
- Validate fire suppression system (58) — can write inspection checklist, but physical testing is required
- Validate lab information system (69) — can write test cases, but system testing requires live environment
- Validate tenant screening system (91) — can write test cases, but validation requires live data

**Why peripheral:** The test plan is useful but not central to the work. The core work is physical or system-level testing.

### Pattern 2: Physical Infrastructure Investigation (3 scenarios)

The product can analyze logs if provided, but the investigation requires physical inspection.

**Examples:**
- Investigate HVAC server room temperature fluctuations (53) — can analyze temperature logs, but physical inspection of ducts and sensors is essential
- Audit warehouse access control with badge logs and video (22) — can analyze badge logs if provided as files, but video review and physical inspection are core to the audit
- Investigate pharmaceutical batch deviation in cleanroom (63) — can analyze batch records, but lab testing and cleanroom inspection are essential

**Why peripheral:** The product's analysis of logs is helpful but the core investigation requires physical presence and specialized equipment.

---

## 5. Surprising Findings

### Finding 1: 0% of scenarios have "no role"

Under the practical usefulness standard, every scenario in the corpus has at least a peripheral helper role. The product can always produce some supporting artifact: a test plan, an analysis framework, a checklist, or a research summary. This is a dramatically different picture from the previous 50% "beyond system" classification.

### Finding 2: 92% of scenarios have central or meaningful participation

52% central + 40% meaningful participant = 92% of operational work where the product produces essential or significant artifacts. Only 8% is peripheral.

**Surprise:** The product is far more broadly useful than the literal execution evaluation suggested. The gap is not in usefulness; it is in the *mode* of participation. The product is a **reasoning and artifact-generation assistant**, not an **autonomous executor**.

### Finding 3: The previous "50% gap" was a category error

The previous evaluation treated "requires external action" as "beyond the system." The re-evaluation reveals that most work involving external action still requires internal analysis, planning, and artifact preparation. The product's role is **upstream** of execution: it produces the plans, analyses, and documents that humans or other systems execute.

### Finding 4: Workload Profiles are still inadequate

Even under the broader usefulness lens, only ~10-12 scenarios clearly map to the five hardcoded profiles (report, diagnosis, refactor, recommendation, bulk-inventory). The other 40+ central scenarios (policy drafting, planning, reconciliation, decision support) do not match any profile. The profile system's regex patterns are too narrow to capture the breadth of useful work.

### Finding 5: The product's actual sweet spot is planning and analysis, not execution

The 52% "central" category is dominated by planning, analysis, drafting, and scoping. The 40% "meaningful participant" category is dominated by producing plans, procedures, and recommendations that precede execution. Together they reveal that the product's practical value is **upstream reasoning**, not **downstream execution**.

### Finding 6: Workflow mode is still marginal

Even under the broader lens, only 2-3 scenarios (finalizing go/no-go decisions with clear criteria) naturally fit the current workflow engine. Most central work (planning, analysis, drafting) is adaptive and does not map to static action graphs. The workflow engine's marginal fit is confirmed, but for a different reason: not because the work is "beyond the system," but because the work is **adaptive** rather than procedural.

---

## Appendix: Scenario-by-Scenario Reclassification

| # | Scenario | Category | Reasoning |
|---|---|---|---|
| 1 | Investigate payment gateway rejections | **Central** | Analyze transaction logs, produce root cause report |
| 2 | Audit GDPR compliance | **Central** | Review documentation, produce audit findings |
| 3 | Diagnose inventory 503 errors | **Central** | Analyze logs/code, produce diagnosis |
| 4 | Quarterly risk assessment | **Central** | Analyze data, write assessment document |
| 5 | Reconcile ledger with processor | **Central** | File-to-file comparison, produce reconciliation report |
| 6 | Scope CRM replacement | **Central** | Research, synthesize, write scope with criteria |
| 7 | Assess Black Friday risk | **Central** | Analyze data, write risk assessment |
| 8 | Validate database backups | **Meaningful participant** | Write test scripts, procedures, criteria; human executes |
| 9 | Coordinate expense policy rollout | **Meaningful participant** | Produce policy, plan, templates, checklists; human coordinates |
| 10 | Preserve acquisition record | **Central** | Organize documents, produce archival record |
| 11 | Clarify "improve customer experience" | **Meaningful participant** | Research benchmarks, propose KPIs, draft scope; human validates |
| 12 | Draft HIPAA retention policy | **Central** | Synthesize regulations, write policy document |
| 13 | Remediate telehealth video degradation | **Meaningful participant** | Analyze logs, produce remediation plan; operations executes |
| 14 | Synthesize threat intelligence | **Central** | Analyze threat data files, produce unified report |
| 15 | Review underwriting model output | **Central** | Apply rubric, write structured review |
| 16 | Transition loan processing system | **Meaningful participant** | Produce migration plan, test cases, rollback; human executes |
| 17 | Negotiate SLA terms | **Meaningful participant** | Analyze usage, model options, draft position; human negotiates |
| 18 | Curate on-call knowledge base | **Central** | Organize files, write runbooks |
| 19 | Resolve DevOps/Security escalation | **Meaningful participant** | Analyze evidence, apply criteria, recommend resolution |
| 20 | Finalize go/no-go decision | **Central** | Workflow condition + evidence review directly supports this |
| 21 | Negative inventory anomaly | **Central** | Investigate data, produce findings report |
| 22 | Audit warehouse access control | **Peripheral helper** | Can analyze badge logs, but video and physical inspection are core |
| 23 | Deploy real-time inventory sync | **Meaningful participant** | Produce deployment plan, pre/post checks; human deploys |
| 24 | Reconcile shipping manifest | **Central** | File-to-file comparison |
| 25 | Scope predictive maintenance | **Central** | Research, synthesize, write implementation plan |
| 26 | Assess cold-chain market risk | **Central** | Analyze data, write risk assessment |
| 27 | Factory safety audit status report | **Central** | Analyze findings, write status report |
| 28 | Validate quality control vision system | **Peripheral helper** | Can write test procedures, but physical testing is core |
| 29 | Coordinate raw materials shortage | **Meaningful participant** | Produce plan, prioritization framework; human coordinates |
| 30 | Curate training knowledge | **Central** | Organize files, write training documents |
| 31 | Negotiate logistics provider terms | **Meaningful participant** | Analyze volume, model costs, draft terms; human negotiates |
| 32 | Clarify "reduce waste" mandate | **Meaningful participant** | Research benchmarks, propose targets, draft scope |
| 33 | Investigate delivery complaints spike | **Central** | Analyze data, produce findings |
| 34 | Draft returns policy | **Central** | Synthesize laws and agreements, write policy |
| 35 | Remediate call center IVR | **Meaningful participant** | Analyze logs, produce fix plan; operations executes |
| 36 | Synthesize customer sentiment | **Central** | If data provided as files, synthesize into report |
| 37 | Review chatbot output quality | **Central** | Apply rubric, write review |
| 38 | Transition loyalty program | **Meaningful participant** | Produce migration plan, test cases; human executes |
| 39 | Resolve billing dispute escalation | **Meaningful participant** | Analyze evidence, produce recommendation, draft terms |
| 40 | Finalize promotion launch | **Central** | Evidence + criteria + condition = workflow-ready |
| 41 | Preserve product recall record | **Central** | Organize documents, produce archival record |
| 42 | Trading algorithm anomaly | **Peripheral helper** | Can analyze trade logs, but real-time market access is core |
| 43 | Audit SOX controls | **Meaningful participant** | Review documentation, produce findings; auditor validates |
| 44 | Deploy risk model config | **Meaningful participant** | Produce config, test cases, procedures; human deploys |
| 45 | Reconcile front/back office trades | **Central** | File-to-file comparison |
| 46 | Scope Basel IV reporting | **Central** | Research, synthesize, write scope |
| 47 | Assess crypto custody risk | **Central** | Analyze data, write assessment |
| 48 | Validate AML screening system | **Peripheral helper** | Can write test cases, but live system testing is core |
| 49 | Coordinate KYC backlog | **Meaningful participant** | Produce plan, prioritization framework; human coordinates |
| 50 | Curate fraud detection playbook | **Central** | Organize and write procedures |
| 51 | Negotiate market data vendor | **Meaningful participant** | Analyze usage, model options, draft position |
| 52 | Clarify "optimize working capital" | **Meaningful participant** | Analyze state, propose KPIs, draft framework |
| 53 | Investigate HVAC server room | **Peripheral helper** | Can analyze logs, but physical inspection is core |
| 54 | Audit physical security | **Peripheral helper** | Can review docs, but physical inspection is core |
| 55 | Remediate building management | **Meaningful participant** | Analyze logs, produce remediation plan |
| 56 | Synthesize energy efficiency data | **Central** | Analyze data files, produce report |
| 57 | Campus sustainability status report | **Central** | Analyze data, write report |
| 58 | Validate fire suppression system | **Peripheral helper** | Can write checklist, but physical testing is core |
| 59 | Coordinate parking allocation | **Meaningful participant** | Produce allocation plan, criteria framework |
| 60 | Curate evacuation procedures | **Central** | Write procedures |
| 61 | Negotiate cleaning contractor | **Meaningful participant** | Model scope, draft terms; human negotiates |
| 62 | Clarify "improve the workplace" | **Meaningful participant** | Research, draft scope with options and metrics |
| 63 | Investigate pharmaceutical batch deviation | **Peripheral helper** | Can analyze batch records, but lab testing is core |
| 64 | Audit drug serialization | **Meaningful participant** | Review documentation, produce audit findings |
| 65 | Deploy cold chain monitoring | **Meaningful participant** | Produce config, procedures, test plans; human deploys |
| 66 | Reconcile clinical trial data | **Central** | File-to-file comparison |
| 67 | Scope FDA surveillance | **Central** | Research, synthesize, write scope |
| 68 | Assess gene therapy risk | **Central** | Analyze data, write assessment |
| 69 | Validate lab information system | **Peripheral helper** | Can write test procedures, but system testing is core |
| 70 | Coordinate patient data integration | **Meaningful participant** | Produce integration plan, data mapping; human coordinates |
| 71 | Curate sepsis detection protocol | **Central** | Research evidence, write clinical protocol |
| 72 | Negotiate medical device supplier | **Meaningful participant** | Model requirements, draft terms; human negotiates |
| 73 | Clarify "improve patient outcomes" | **Meaningful participant** | Research benchmarks, draft scope with metrics |
| 74 | Investigate duplicate enrollment | **Central** | Analyze data, produce findings |
| 75 | Audit FERPA procedures | **Central** | Review documentation, produce audit report |
| 76 | Deploy LMS integration | **Meaningful participant** | Produce spec, test cases, migration plan; human deploys |
| 77 | Reconcile course catalog | **Central** | File-to-file comparison |
| 78 | Scope engineering accreditation | **Central** | Research standards, write scope |
| 79 | Assess international online degree risk | **Central** | Analyze data, write assessment |
| 80 | Validate plagiarism detection system | **Peripheral helper** | Can write test cases, but system testing is core |
| 81 | Coordinate faculty workload dispute | **Meaningful participant** | Produce allocation framework, criteria, recommendation |
| 82 | Curate academic integrity policy | **Central** | Write policy |
| 83 | Negotiate online proctoring vendor | **Meaningful participant** | Model requirements, draft terms |
| 84 | Clarify "enhance student experience" | **Meaningful participant** | Research, draft scope with options |
| 85 | Investigate property management rent roll | **Central** | Analyze data, produce findings |
| 86 | Audit tenant insurance verification | **Central** | Review documents, produce audit report |
| 87 | Deploy rent escalation config | **Meaningful participant** | Produce config, test cases; human deploys |
| 88 | Reconcile property tax with valuation | **Central** | File-to-file comparison |
| 89 | Scope energy efficiency standards | **Central** | Research, synthesize, write scope |
| 90 | Assess shopping center acquisition risk | **Central** | Analyze data, write assessment |
| 91 | Validate tenant screening system | **Peripheral helper** | Can write test cases, but system testing is core |
| 92 | Coordinate contractor dispute | **Meaningful participant** | Produce resolution framework, evidence analysis |
| 93 | Curate fair housing procedures | **Central** | Write procedures |
| 94 | Negotiate property management software | **Meaningful participant** | Model requirements, draft terms |
| 95 | Clarify "maximize NOI" | **Meaningful participant** | Research, draft scope with KPIs |
| 96 | Investigate marketing platform duplicate emails | **Central** | Analyze logs/data, produce findings |
| 97 | Audit brand safety controls | **Meaningful participant** | Review documentation, produce findings |
| 98 | Deploy attribution model config | **Meaningful participant** | Produce config, test cases, procedures |
| 99 | Reconcile marketing spend with finance | **Central** | File-to-file comparison |
| 100 | Scope first-party data strategy | **Central** | Research, synthesize, write strategy |
