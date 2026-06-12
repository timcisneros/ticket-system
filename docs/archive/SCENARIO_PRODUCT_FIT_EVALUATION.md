# Product Fit Evaluation: 100 Business Scenarios

## Method

Each scenario was evaluated against the current product as it exists today:

- **Ticket:** Free-text objective, assignment, status tracking.
- **Agent mode:** File operations (list, read, write, create, rename, delete) within workspace, bounded by runtime limits and phase enforcement.
- **Workflow system:** Static action graphs (`writeFile`, `agentStructuredOutput`, `condition`, `stop`) with deterministic branching.
- **Workload profiles:** Five hardcoded regex-detected profiles (`report`, `diagnosis`, `refactor`, `recommendation`, `bulk-inventory`) that adjust runtime limits and inject behavioral guidance into prompts.

**Key constraint:** Scenarios requiring external system access (APIs, databases, physical devices), real-time interaction, multi-party human coordination, or system deployment were classified as beyond current capabilities.

---

## 1. Distribution of Fit Categories

| Category | Description | Count | Percentage |
|---|---|---|---|
| **A. Ticket only** | Pure tracking; no execution needed | 0 | 0% |
| **B. Ticket + agent mode** | Expressible as agent-mode ticket with file-based execution | 42 | 42% |
| **C. Ticket + workflow system** | Best handled by current workflow engine | 2 | 2% |
| **D. Ticket + workload profiles** | Agent mode where one of the 5 profiles applies | 6 | 6% |
| **E. Requires capability not present** | Beyond current system boundaries | 50 | 50% |

**Total:** 100 scenarios

---

## 2. Common Patterns That Fit Well (Categories B and D)

### Pattern 1: Document Analysis and Reporting (18 scenarios)

Scenarios involving reading existing documents, analyzing content, and writing findings to new files.

**Examples:**
- Quarterly risk assessment (4)
- Security audit report (3)
- Returns policy drafting (34)
- Factory floor safety status report (27)
- Academic integrity policy curation (82)

**Why they fit:** The agent can `readFile` source documents and `writeFile` output reports. The work is bounded to the workspace.

### Pattern 2: Reconciliation Between Document Sets (8 scenarios)

Scenarios involving comparing two sets of records and identifying discrepancies.

**Examples:**
- Reconcile ledger with settlement reports (5)
- Reconcile shipping manifests (24)
- Reconcile front/back office trades (45)
- Reconcile property tax with valuation (88)

**Why they fit:** If both datasets are available as files, the agent can read both, compare, and write the reconciliation.

### Pattern 3: Planning and Scoping (14 scenarios)

Scenarios requiring synthesis of existing information into plans, strategies, or recommendations.

**Examples:**
- Scope CRM replacement initiative (6)
- Scope predictive maintenance (25)
- Scope FDA post-market surveillance (67)
- Scope first-party data strategy (100)

**Why they fit:** The agent can read reference documents and write planning documents.

---

## 3. Common Patterns That Fit Poorly (Category E)

### Pattern 1: System Deployment and Configuration (12 scenarios)

Any scenario requiring actual system changes, deployment, or live configuration updates.

**Examples:**
- Deploy real-time inventory sync (23)
- Deploy cold chain monitoring thresholds (65)
- Deploy LMS integration (76)
- Deploy attribution model config (98)

**Why they don't fit:** The agent can only write files. It cannot restart services, update databases, modify running configurations, or trigger deployments.

### Pattern 2: Physical World Operations (10 scenarios)

Scenarios involving physical infrastructure, devices, or on-site verification.

**Examples:**
- Audit warehouse access control with badge logs and video (22)
- Validate quality control vision system (28)
- Investigate HVAC server room anomaly (53)
- Validate fire suppression system (58)

**Why they don't fit:** The agent has no interface to physical systems, sensors, cameras, or facilities.

### Pattern 3: External Negotiation (8 scenarios)

Scenarios requiring back-and-forth negotiation with external parties.

**Examples:**
- Negotiate SLA terms with cloud provider (17)
- Negotiate logistics provider surge capacity (31)
- Negotiate market data vendor terms (51)
- Negotiate medical device supplier (72)

**Why they don't fit:** The agent cannot send emails, make calls, or participate in multi-turn negotiations with external humans.

### Pattern 4: Multi-Party Coordination (9 scenarios)

Scenarios requiring orchestration across teams, departments, or organizations.

**Examples:**
- Coordinate expense approval policy rollout across 12 offices (9)
- Coordinate raw materials shortage resolution (29)
- Coordinate patient data integration between hospital and clinic (70)
- Resolve escalation between DevOps and Security (19)

**Why they don't fit:** The agent cannot send notifications, track acknowledgments, or manage cross-organizational workflows.

### Pattern 5: Stakeholder Clarification (7 scenarios)

Scenarios requiring interactive clarification with humans to resolve ambiguity.

**Examples:**
- Clarify "improve customer experience" mandate (11)
- Clarify "reduce waste" mandate (32)
- Clarify "optimize working capital" (52)
- Clarify "maximize NOI" (95)

**Why they don't fit:** The agent cannot ask follow-up questions, wait for responses, or iteratively refine requirements with stakeholders.

---

## 4. Scenarios That Expose the Largest Gaps

### Gap 1: System Validation (8 scenarios)

Scenarios requiring confirmation that a live system is functioning correctly.

- Validate database backups are recoverable within 4-hour RTO (8)
- Validate AML screening system before regulator review (48)
- Validate plagiarism detection system before midterms (80)
- Validate tenant screening system before peak season (91)

**Gap:** The system can write test scripts but cannot execute them, verify system state, or interact with infrastructure.

### Gap 2: Real-Time Operational Response (6 scenarios)

Scenarios requiring immediate action on live systems.

- Remediate telehealth video degradation affecting rural clinics (13)
- Remediate call center IVR abandonment during peak hours (35)
- Remediate building management system affecting elevators (55)
- Investigate trading algorithm unexpected positions (42)

**Gap:** The agent cannot monitor live systems, receive alerts, or trigger operational responses in real time.

### Gap 3: Cross-Organizational Coordination (9 scenarios)

Scenarios requiring action across organizational boundaries.

- Coordinate expense policy rollout across 12 regional offices (9)
- Coordinate KYC backlog affecting new account openings (49)
- Coordinate faculty workload dispute (81)
- Coordinate contractor dispute delaying development (92)

**Gap:** No capability to track multi-party acknowledgments, route decisions, or manage cross-boundary workflows.

### Gap 4: External Contracting and Procurement (8 scenarios)

Scenarios requiring negotiation and agreement with external vendors.

- Negotiate cloud provider SLA terms (17)
- Negotiate cleaning contractor for expanded space (61)
- Negotiate online proctoring vendor (83)
- Negotiate property management software modules (94)

**Gap:** No capability for proposal/counter-proposal cycles, terms tracking, or external party acknowledgment.

### Gap 5: Physical and Environmental Systems (10 scenarios)

Scenarios involving facilities, manufacturing, and physical infrastructure.

- Audit warehouse access with badge logs and video (22)
- Investigate HVAC server room temperature fluctuations (53)
- Validate fire suppression system before inspection (58)
- Investigate pharmaceutical batch deviation in cleanroom (63)

**Gap:** No interface to building systems, manufacturing equipment, environmental sensors, or physical security.

---

## 5. Surprising Findings

### Finding 1: Only 6% match workload profiles

Of 100 realistic business scenarios, only 6 matched one of the five hardcoded workload profiles:
- 2 matched `report` ("audit" scenarios)
- 2 matched `report` ("status report" scenarios)
- 1 matched `report` ("audit FERPA")
- 1 matched `report` ("audit tenant insurance")
- 1 matched `diagnosis` ("diagnose inventory 503 errors")

**Surprise:** The profile system, which the investigation identified as the "center of gravity" of the latent BWD layer, is nearly invisible to realistic business work. The regex patterns are too narrow and domain-specific to catch most operational scenarios.

### Finding 2: Only 2% naturally fit workflow mode

Only 2 of 100 scenarios (finalize go/no-go decision, finalize promotion launch) map naturally to the current workflow engine's capabilities (condition + writeFile). The workflow system's rigid structure (agentStructuredOutput → condition → writeFile → stop) is too limited for most business work.

**Surprise:** Despite the investigation concluding that the workflow abstraction "survived," the actual workflow implementation can express almost none of the corpus.

### Finding 3: 50% of scenarios are completely beyond the system

Half the corpus requires capabilities the product does not have: external system access, physical world interaction, human negotiation, multi-party coordination, real-time monitoring.

**Surprise:** The gap is not missing features within the existing architecture. The gap is architectural: the product is a file-bound workspace tool, and 50% of operational work inherently requires interaction with systems, people, and infrastructure outside the workspace.

### Finding 4: The 42% that fit (B) are almost entirely document work

All 42 agent-mode-fitting scenarios involve reading files, analyzing content, and writing output files. None involve changing external systems, coordinating with people, or monitoring live infrastructure.

**Surprise:** The product is effectively a "document analysis and report generation" system disguised as an operational AI platform. The 100-scenario corpus exposes this sharply.

### Finding 5: No scenario is "ticket only"

Every scenario in the corpus requires execution, not just tracking. The ticket abstraction alone is insufficient for any realistic operational work.

**Surprise:** The ticket's purpose as a "sufficient request mechanism" is validated, but its limitation as an "insufficient definition mechanism" is also confirmed. Even the simplest scenario requires execution.

---

## Appendix: Scenario-by-Scenario Classification

| # | Scenario | Category | Reason |
|---|---|---|---|
| 1 | Investigate payment gateway rejections | B | File-based log analysis |
| 2 | Audit GDPR compliance | D | `audit` matches `report` profile |
| 3 | Diagnose inventory 503 errors | D | `diagnos` matches `diagnosis` profile |
| 4 | Quarterly risk assessment | B | Document analysis and report writing |
| 5 | Reconcile ledger with processor | B | File-based reconciliation |
| 6 | Scope CRM replacement | B | Planning document from reference files |
| 7 | Assess Black Friday risk | B | Risk analysis from files |
| 8 | Validate database backups | E | Requires infrastructure testing |
| 9 | Coordinate expense policy rollout | E | Multi-party coordination across 12 offices |
| 10 | Preserve acquisition record | B | File organization and archival |
| 11 | Clarify "improve customer experience" | E | Requires stakeholder interaction |
| 12 | Draft HIPAA retention policy | B | Policy drafting from reference files |
| 13 | Remediate telehealth video degradation | E | Requires system access |
| 14 | Synthesize threat intelligence | B | File-based synthesis (if data available) |
| 15 | Review underwriting model output | B | File-based review and rubric application |
| 16 | Transition loan processing system | E | Requires system migration |
| 17 | Negotiate SLA terms | E | External negotiation |
| 18 | Curate on-call knowledge base | B | File organization and writing |
| 19 | Resolve DevOps/Security escalation | E | Multi-party arbitration |
| 20 | Finalize go/no-go decision | C | Condition-based deterministic branching |
| 21 | Negative inventory anomaly | B | File-based investigation |
| 22 | Audit warehouse access control | E | Physical access required |
| 23 | Deploy real-time inventory sync | E | System deployment |
| 24 | Reconcile shipping manifest | B | File-based reconciliation |
| 25 | Scope predictive maintenance | B | Planning document |
| 26 | Assess cold-chain market risk | B | Risk analysis from files |
| 27 | Factory safety audit status report | D | `report` profile match |
| 28 | Validate quality control vision system | E | Physical system testing |
| 29 | Coordinate raw materials shortage | E | Multi-party coordination |
| 30 | Curate training knowledge | B | File organization |
| 31 | Negotiate logistics provider terms | E | External negotiation |
| 32 | Clarify "reduce waste" mandate | E | Stakeholder interaction |
| 33 | Investigate delivery complaints spike | B | File-based investigation |
| 34 | Draft returns policy | B | Policy drafting |
| 35 | Remediate call center IVR | E | System access required |
| 36 | Synthesize customer sentiment | E | External data access (social media) |
| 37 | Review chatbot output quality | B | File-based review |
| 38 | Transition loyalty program | E | System migration |
| 39 | Resolve billing dispute escalation | E | Multi-party arbitration |
| 40 | Finalize promotion launch | C | Condition-based decision |
| 41 | Preserve product recall record | B | File archival |
| 42 | Trading algorithm anomaly | E | Real-time trading system |
| 43 | Audit SOX controls | E | System audit requiring access |
| 44 | Deploy risk model config | E | System deployment |
| 45 | Reconcile front/back office trades | B | File-based reconciliation |
| 46 | Scope Basel IV reporting | B | Planning document |
| 47 | Assess crypto custody risk | B | Risk analysis from files |
| 48 | Validate AML screening system | E | System testing |
| 49 | Coordinate KYC backlog | E | Multi-party coordination |
| 50 | Curate fraud detection playbook | B | File organization |
| 51 | Negotiate market data vendor | E | External negotiation |
| 52 | Clarify "optimize working capital" | E | Stakeholder interaction |
| 53 | Investigate HVAC server room | E | Physical system |
| 54 | Audit physical security | E | Physical access |
| 55 | Remediate building management | E | System access |
| 56 | Synthesize energy efficiency data | B | File-based synthesis |
| 57 | Campus sustainability status report | D | `report` profile match |
| 58 | Validate fire suppression system | E | Physical testing |
| 59 | Coordinate parking allocation | E | Multi-party coordination |
| 60 | Curate evacuation procedures | B | File writing |
| 61 | Negotiate cleaning contractor | E | External negotiation |
| 62 | Clarify "improve workplace" | E | Stakeholder interaction |
| 63 | Investigate pharmaceutical batch | E | Physical cleanroom access |
| 64 | Audit drug serialization | E | System audit |
| 65 | Deploy cold chain monitoring | E | System deployment |
| 66 | Reconcile clinical trial data | B | File-based reconciliation |
| 67 | Scope FDA surveillance | B | Planning document |
| 68 | Assess gene therapy risk | B | Risk analysis from files |
| 69 | Validate lab information system | E | System testing |
| 70 | Coordinate patient data integration | E | Multi-party + system integration |
| 71 | Curate sepsis detection protocol | B | File writing |
| 72 | Negotiate medical device supplier | E | External negotiation |
| 73 | Clarify "improve patient outcomes" | E | Stakeholder interaction |
| 74 | Investigate duplicate enrollment | B | File-based investigation |
| 75 | Audit FERPA procedures | D | `audit` matches `report` profile |
| 76 | Deploy LMS integration | E | System deployment |
| 77 | Reconcile course catalog | B | File-based reconciliation |
| 78 | Scope engineering accreditation | B | Planning document |
| 79 | Assess international online degree risk | B | Risk analysis from files |
| 80 | Validate plagiarism detection system | E | System testing |
| 81 | Coordinate faculty workload dispute | E | Multi-party coordination |
| 82 | Curate academic integrity policy | B | File writing |
| 83 | Negotiate online proctoring vendor | E | External negotiation |
| 84 | Clarify "enhance student experience" | E | Stakeholder interaction |
| 85 | Investigate property management rent roll | B | File-based investigation |
| 86 | Audit tenant insurance verification | D | `audit` matches `report` profile |
| 87 | Deploy rent escalation config | E | System deployment |
| 88 | Reconcile property tax with valuation | B | File-based reconciliation |
| 89 | Scope energy efficiency standards | B | Planning document |
| 90 | Assess shopping center acquisition risk | B | Risk analysis from files |
| 91 | Validate tenant screening system | E | System testing |
| 92 | Coordinate contractor dispute | E | Multi-party coordination |
| 93 | Curate fair housing procedures | B | File writing |
| 94 | Negotiate property management software | E | External negotiation |
| 95 | Clarify "maximize NOI" | E | Stakeholder interaction |
| 96 | Investigate marketing platform duplicate emails | B | File-based investigation |
| 97 | Audit brand safety controls | E | System audit |
| 98 | Deploy attribution model config | E | System deployment |
| 99 | Reconcile marketing spend with finance | B | File-based reconciliation |
| 100 | Scope first-party data strategy | B | Planning document |
