# Business Fixture Plan V2 — Business-State Fixtures

## Preamble

Fixtures are **demonstration and evaluation environments**.

They are designed to approximate real business decision-making workloads inside a filesystem. They use files as inputs and produce files as outputs because that is the substrate the current runtime operates on.

They are **not** intended to represent the architecture of the final product. A real legal team uses a case management system. A real support team uses Zendesk. A real compliance team uses a VMS. The fixtures do not claim these are the final workflow engines.

Evaluate fixtures on:

- **Realism of decisions** — do the decisions resemble what a real worker would conclude?
- **Realism of ambiguity** — do the inputs contain edge cases, missing fields, and conflicting signals that a real worker would encounter?
- **Realism of artifact production** — do the produced documents resemble what a real team would create for tracking, reporting, and handoff?

Do **not** evaluate fixtures on:

- **Whether real businesses literally move files between folders as their workflow engine** — they do not. The filesystem is the substrate, not the product.

---

## Design Principle

The agent **reads** source materials and **writes** business-state artifacts.

Source materials remain in place. The produced artifacts represent decisions, tracking, and summaries. The workspace becomes a working directory where business state is documented, not a routing system where files are shuffled between folders.

---

## Fixture 1: Legal Intake Tracker

### Business Owner
Legal operations manager or in-house counsel at a company with recurring legal volume.

### Source Materials
A set of intake forms submitted by business units. Each form is a markdown file in `legal-intake/incoming/`.

**Example files:**
- `legal-intake/incoming/intake-2026-001.md` — complete contract review request
- `legal-intake/incoming/intake-2026-002.md` — incomplete dispute (missing party name)
- `legal-intake/incoming/intake-2026-003.md` — complete NDA request
- `legal-intake/incoming/intake-2026-004.md` — incomplete compliance question (missing jurisdiction)
- `legal-intake/incoming/intake-2026-005.md` — complete policy review
- `legal-intake/incoming/intake-2026-006.md` — vague description (needs clarification)
- `legal-intake/incoming/intake-2026-007.md` — complete IP assessment
- `legal-intake/incoming/intake-2026-008.md` — incomplete matter (missing contact email)
- `legal-intake/incoming/intake-2026-009.md` — complete employment agreement review
- `legal-intake/incoming/intake-2026-010.md` — incomplete (missing matter type)

**Intake form template:**
```markdown
# Legal Intake Form

## Matter Type
Contract Review

## Requesting Party
Acme Corporation

## Contact Email
legal@acme.example.com

## Jurisdiction
Delaware, USA

## Description
Review SaaS subscription agreement for renewal.

## Urgency
Standard
```

### Business Decision
For each intake form, determine:
1. **Open Matter** — all required fields present, can proceed
2. **Request Information** — missing a field that can be obtained with one email (jurisdiction, description, contact email)
3. **Decline** — missing a critical field that prevents any work (matter type or requesting party), or the request is outside legal scope

### Produced Artifacts
1. **`legal-intake/intake-register.csv`** — structured tracker
   ```csv
   intake_id,matter_type,requesting_party,disposition,reason,next_action
   intake-2026-001,Contract Review,Acme Corporation,Open,All fields complete,Assign to contract team
   intake-2026-002,Dispute,[MISSING],Decline,Missing requesting party,Email requester for party name
   ```

2. **`legal-intake/matter-summary.md`** — narrative summary for the legal team lead
   - Total intakes received
   - Breakdown by disposition (Open / Request Info / Decline)
   - List of matters opened with assigned type
   - List of declined matters with reason
   - Recommended follow-up actions for "Request Info" items

### Reviewable Output
A legal ops manager would review:
- Did every intake get a disposition?
- Are the dispositions consistent with the form contents?
- Are "Decline" items actually unworkable?
- Are "Request Info" items salvageable with one email?
- Does the matter-summary help the lead plan the week?

### Success Metric
1. **Coverage**: Every intake file in `incoming/` is listed in the register.
2. **Consistency**: Dispositions match the form contents (e.g., a form with `[MISSING]` for Requesting Party should not be "Open").
3. **Actionability**: Each "Request Info" and "Decline" entry includes a `next_action` that is specific and feasible.
4. **No hallucination**: No intake IDs appear in the register that do not exist in `incoming/`.

---

## Fixture 2: Customer Support Triage Plan

### Business Owner
Support team lead or customer success manager.

### Source Materials
A set of customer support tickets. Each ticket is a text file in `support-inbox/`.

**Example files:**
- `support-inbox/ticket-001.txt` — payment API returning 500s for all users
- `support-inbox/ticket-002.txt` — dark mode toggle not persisting
- `support-inbox/ticket-003.txt` — how to export report to PDF
- `support-inbox/ticket-004.txt` — database replication lag causing stale data
- `support-inbox/ticket-005.txt` — feature request for keyboard shortcuts
- `support-inbox/ticket-006.txt` — login page shows generic error
- `support-inbox/ticket-007.txt` — all file uploads failing with timeout
- `support-inbox/ticket-008.txt` — question about supported browsers
- `support-inbox/ticket-009.txt` — memory leak in background worker
- `support-inbox/ticket-010.txt` — request for SSO integration timeline

**Ticket template:**
```
Subject: Payment API returning 500s for all users since 09:00 UTC

Description: Since 09:00 UTC today, all payment processing requests
return HTTP 500. Affecting all customers globally.

Customer: Acme Corp (Enterprise)
```

### Business Decision
For each ticket, determine:
1. **Priority**: P1 (production outage / all users), P2 (functional bug / some users), P3 (question / feature request)
2. **Assignee team**: Engineering (for bugs), Customer Success (for questions), Product (for feature requests), On-Call (for P1)
3. **Escalation**: Yes (for P1), No (for P2/P3)
4. **First response SLA**: 1 hour (P1), 4 hours (P2), 24 hours (P3)

### Produced Artifacts
1. **`support-queue/triage-plan.md`** — the handoff document the support lead uses at shift change
   - Table: ticket ID | priority | assignee team | escalation | SLA | suggested first response
   - P1 items grouped at the top with explicit escalation instructions
   - P2 items grouped by team
   - P3 items grouped by type (question vs feature request)

2. **`support-queue/escalation-list.md`** — the list sent to on-call engineering immediately
   - Each P1 with: ticket ID, customer, impact summary, time received, suggested action
   - Total P1 count

### Reviewable Output
A support lead would review:
- Are all tickets accounted for?
- Are P1s identified correctly?
- Are P2s assigned to the right team?
- Are P3s deprioritized appropriately?
- Is the escalation list actionable for on-call?
- Does the triage plan help the next shift pick up work?

### Success Metric
1. **Coverage**: Every ticket in `support-inbox/` appears in the triage plan.
2. **P1 accuracy**: All tickets with production-outage or all-users impact are flagged P1 and escalated.
3. **Assignment plausibility**: Bugs go to Engineering, questions to Customer Success, feature requests to Product.
4. **No hallucination**: No ticket IDs in the plan that do not exist.
5. **Escalation list completeness**: Every P1 in the triage plan also appears in the escalation list.

---

## Fixture 3: Vendor Compliance Decision Register

### Business Owner
Procurement compliance officer or third-party risk manager (TPRM).

### Source Materials
Vendor packets and company policies.

**Vendor packets** (one folder per vendor in `vendors/incoming/`):
- `vendors/incoming/vendor-alpha/`:
  - `vendor-profile.md` — company info, service category, contact
  - `dpa.md` — data processing agreement
  - `soc2-cert.md` — SOC 2 Type II report (valid, expires 2026-06-01)
- `vendors/incoming/vendor-beta/`:
  - `vendor-profile.md`
  - `dpa.md`
  - (missing security certification)
- `vendors/incoming/vendor-gamma/`:
  - `vendor-profile.md`
  - `dpa.md`
  - `soc2-cert.md` — expired (expired 2025-06-01)
- `vendors/incoming/vendor-delta/`:
  - `vendor-profile.md`
  - `dpa.md`
  - `iso27001-cert.md` — valid, expires 2026-12-01
- `vendors/incoming/vendor-epsilon/`:
  - `vendor-profile.md`
  - `dpa.md`
  - `soc2-cert.md` — valid, expires 2026-09-01

**Policies** (in `policies/`):
- `policies/vendor-onboarding-policy.md` — required documents, approval conditions
- `policies/data-processing-requirements.md` — DPA requirements
- `policies/security-certification-requirements.md` — acceptable certifications and validity rules

**Incident records** (in `incidents/`):
- `incidents/incident-2026-001.md` — references vendor-gamma, open status

### Business Decision
For each vendor, determine:
1. **Approve** — all required documents present, certification valid and not expiring within 6 months, no active incidents
2. **Conditional Approve** — all documents present, but certification expires within 6 months OR an incident exists but is minor/resolved
3. **Reject** — missing required document, certification expired, or critical active incident
4. **Reason** — specific policy rule or document gap that justifies the decision

### Produced Artifacts
1. **`vendors/vendor-decision-register.csv`** — structured compliance tracker
   ```csv
   vendor_id,vendor_name,disposition,reason,policy_reference,next_action
   vendor-alpha,Alpha Cloud Services,Approve,All docs valid; cert expires 2026-06-01,Vendor Onboarding Policy §3.1,None
   vendor-beta,Beta Analytics,Reject,Missing security certification,Security Certification Requirements §2.1,Request SOC 2 or ISO 27001
   vendor-gamma,Gamma Storage,Reject,Cert expired 2025-06-01; active incident INC-2026-001,Vendor Onboarding Policy §4.2,Vendor must renew cert and close incident
   ```

2. **`vendors/compliance-review.md`** — narrative report for audit and management
   - Executive summary: total vendors reviewed, approved count, rejected count, conditional count
   - Per-vendor finding with policy evidence
   - Risk classification: high (rejected), medium (conditional), low (approved)
   - Recommended remediation for rejected and conditional vendors
   - Timeline recommendations (e.g., "Vendor Gamma must renew cert by Q3")

### Reviewable Output
A compliance officer would review:
- Did every vendor packet get evaluated?
- Are the dispositions consistent with the policy requirements?
- Are rejected vendors actually non-compliant?
- Are conditional vendors flagged for follow-up?
- Is the compliance-review suitable for an audit evidence package?
- Are the policy references specific and accurate?

### Success Metric
1. **Coverage**: Every vendor folder in `vendors/incoming/` is listed in the register.
2. **Policy alignment**: Dispositions match the rules in `policies/` (e.g., missing cert → reject).
3. **Evidence-based**: Each row in the register references a specific document or policy clause.
4. **No hallucination**: No vendor IDs or policy references that do not exist.
5. **Audit readiness**: The compliance-review.md contains an executive summary and per-vendor findings suitable for an auditor.

---

## Fixture 4: Shared Drive Cleanup (Filesystem Operation Fixture)

### Business Owner
IT administrator or records manager.

### Source Materials
A shared drive with accumulated files. This fixture is different from the others — it is a **filesystem operation** fixture, not a business decision fixture. The agent's job is to inspect, classify, and mutate the filesystem.

**Example structure:**
```
shared-drive/
├── project-alpha/
│   ├── spec-v1.md
│   ├── spec_v2.md
│   ├── meeting-notes-jan-2025.txt
│   ├── meeting_notes_feb_2025.txt
│   └── report-Q1-2025.pdf
├── project-beta/
│   ├── README.md
│   ├── readme.md
│   ├── deploy-script.sh
│   └── deploy_script.sh
├── active/
│   ├── sprint-23-goals.md
│   └── current-roadmap.md
└── misc/
    ├── temp-backup-2024-06.tar
    ├── temp_backup_2024_07.tar
    └── scratchpad.txt
```

### Business Decision
For each file or group of files:
1. **Duplicate** — same content, different name (case variant, hyphen vs underscore)
2. **Stale** — last modified date older than 12 months, or filename contains old year
3. **Inconsistent naming** — uses underscores instead of hyphens, or mixed case variants
4. **Current** — recent, standard naming, no duplicates

### Produced Artifacts
1. **`shared-drive/migration-report.md`** — the report the IT admin sends to management
   - Executive summary: total files scanned, duplicates found, stale files found, naming inconsistencies
   - Action log: each file action (moved to archive, moved to duplicates, renamed and moved to normalized)
   - Files left in place: list of current files with justification
   - Storage impact estimate

2. **`shared-drive/cleanup-log.csv`** — structured log for audit and rollback
   ```csv
   original_path,action,new_path,reason
   project-beta/readme.md,move,duplicates/readme.md,Duplicate of README.md
   project-alpha/report-Q1-2025.pdf,move,archive/report-Q1-2025.pdf,Stale (filename date Q1 2025)
   project-alpha/spec_v2.md,rename+move,normalized/spec-v2.md,Naming inconsistency (underscore to hyphen)
   ```

### Actual Mutations
- `createFolder` — `shared-drive/archive/`, `shared-drive/duplicates/`, `shared-drive/normalized/`
- `renamePath` — move stale files to `archive/`
- `renamePath` — move duplicate files to `duplicates/`
- `renamePath` — rename inconsistent files to kebab-case and move to `normalized/`

**Note**: This is the only fixture where the agent actually moves source files. That is because the business output *is* the cleaned filesystem. The other fixtures produce business-state documents while leaving sources in place.

### Reviewable Output
An IT manager would review:
- Did the report accurately count duplicates, stale files, and inconsistencies?
- Were current files left in place?
- Can the cleanup be audited and rolled back using the log?
- Is the storage impact documented?

### Success Metric
1. **Coverage**: The report accounts for all files in `shared-drive/`.
2. **Accuracy**: Stale files are actually old; duplicates are actually identical; inconsistencies are naming variants.
3. **Preservation**: Current/active files are not moved.
4. **Auditability**: The cleanup-log.csv contains original and new paths for every mutated file.
5. **No data loss**: No files are deleted.

---

## Cross-Fixture Comparison

| Fixture | Type | Inputs Stay In Place | Agent Creates | Agent Mutates Inputs |
|---------|------|----------------------|---------------|----------------------|
| Legal Intake | Business decision | Yes | `intake-register.csv`, `matter-summary.md` | No |
| Customer Support | Business decision | Yes | `triage-plan.md`, `escalation-list.md` | No |
| Vendor Compliance | Business decision | Yes | `vendor-decision-register.csv`, `compliance-review.md` | No |
| Shared Drive Cleanup | Filesystem operation | Partial | `migration-report.md`, `cleanup-log.csv` | Yes (moves files) |

---

## Implementation Priority

1. **Legal Intake Tracker** — simplest business-state fixture, clear inputs and outputs
2. **Customer Support Triage Plan** — slightly more complex (priority + assignment + escalation)
3. **Vendor Compliance Decision Register** — most complex (cross-document policy evaluation)
4. **Shared Drive Cleanup** — separate category, requires actual file moves

---

## Design Rules (Enforced)

1. **Business-state fixtures do not move source files.** The agent reads inputs and writes outputs. Inputs remain where they are.
2. **Outputs are business artifacts:** trackers, registers, plans, summaries — not folder trees.
3. **Success criteria are business outcomes:** coverage, consistency, actionability — not folder placement.
4. **Verifiers check document content against source materials:** Does the register correctly reflect the intake forms? Does the triage plan correctly reflect the tickets?
5. **Shared Drive Cleanup is the exception:** It is a filesystem operation fixture where the business output is the cleaned filesystem.

---

## Detailed Fixture Design

### Fixture 1: Legal Intake Tracker — Detailed Design

#### Ambiguity and Edge Cases

Real legal intake contains judgment calls. The fixture must include edge cases that test whether the agent applies rules with nuance.

**Edge case 1 — Urgent but incomplete:**
- Form has `[MISSING]` for Contact Email but Urgency is "Critical (same day)"
- A rigid rule says "missing email = request info"
- A nuanced rule says "if urgency is critical, open the matter and find the contact through other channels"
- The fixture seeds one of each to test consistency.

**Edge case 2 — Complete but vague description:**
- All fields present, but Description is "Help with contract"
- Does "vague description" matter if all fields are present?
- Real legal ops might open it and clarify later, or might flag it for followup.
- The fixture seeds one with vague description to see if the agent is consistent.

**Edge case 3 — Duplicate intake:**
- Two forms from the same party about the same matter, submitted 10 minutes apart.
- Real legal ops would open one matter and note the duplicate.
- The fixture seeds a duplicate to test whether the agent detects it.

**Edge case 4 — Out-of-scope matter type:**
- Matter Type is "Personal legal advice" or "Real estate purchase"
- Real legal would decline as outside scope.
- The fixture seeds one out-of-scope intake.

**Edge case 5 — Jurisdiction mismatch:**
- Jurisdiction says "California" but the party is a Delaware entity.
- Not a missing field, but a potential issue.
- Real legal ops would open it and note the discrepancy.
- The fixture seeds one with a subtle mismatch.

#### Seed Data Generation Strategy

The generator script accepts parameters:

| Parameter | Default | Description |
|-----------|---------|-------------|
| `--count` | 10 | Number of intake forms |
| `--complete-rate` | 0.5 | Fraction with all required fields |
| `--critical-urgency-rate` | 0.2 | Fraction marked urgent |
| `--out-of-scope-rate` | 0.1 | Fraction with out-of-scope matter type |
| `--duplicate-rate` | 0.1 | Fraction that are duplicates of another form |
| `--vague-description-rate` | 0.1 | Fraction with vague descriptions |
| `--seed` | random | Random seed for determinism |

Template fields:
```javascript
const MATTER_TYPES = [
  'Contract Review', 'NDA Request', 'Dispute', 'Compliance Question',
  'IP Assessment', 'Employment Agreement', 'Policy Review',
  'Outside Scope' // seeded only when out-of-scope flag is set
];

const COMPANIES = [
  'Acme Corporation', 'Globex Industries', 'Initech LLC',
  'Umbrella Corp', 'Hooli Inc', 'Stark Enterprises',
  'Wayne Industries', 'Cyberdyne Systems'
];

const JURISDICTIONS = [
  'Delaware, USA', 'California, USA', 'New York, USA',
  'Texas, USA', 'London, UK', 'Dublin, IE'
];
```

The generator ensures determinism by:
1. Using a seeded random number generator
2. Assigning edge cases first (duplicates, out-of-scope, critical)
3. Filling remaining slots with standard complete/incomplete forms
4. Writing files in intake-NNNN format with sequential IDs

#### Verifier Design

The verifier runs deterministic checks on the produced artifacts:

```javascript
function verifyLegalIntake(workspaceRoot) {
  // 1. Coverage check
  const incomingFiles = fs.readdirSync(path.join(workspaceRoot, 'legal-intake/incoming'))
    .filter(f => f.match(/intake-\d{4}\.md$/));
  const register = parseCSV(path.join(workspaceRoot, 'legal-intake/intake-register.csv'));
  assert(register.length === incomingFiles.length,
    `Register has ${register.length} rows, expected ${incomingFiles.length}`);

  // 2. Consistency check — seeded edge cases
  for (const row of register) {
    const intakeFile = path.join(workspaceRoot, 'legal-intake/incoming', row.intake_id + '.md');
    const intakeContent = fs.readFileSync(intakeFile, 'utf8');

    // If Requesting Party is [MISSING], disposition should not be "Open"
    if (intakeContent.includes('## Requesting Party\n\n[MISSING]')) {
      assert(row.disposition !== 'Open',
        `${row.intake_id}: missing party but marked Open`);
    }

    // If out-of-scope matter type, disposition should be "Decline"
    if (intakeContent.includes('## Matter Type\n\nPersonal legal advice')) {
      assert(row.disposition === 'Decline',
        `${row.intake_id}: out-of-scope but not declined`);
    }
  }

  // 3. Actionability check
  for (const row of register) {
    if (row.disposition === 'Request Information' || row.disposition === 'Decline') {
      assert(row.next_action && row.next_action.length > 10,
        `${row.intake_id}: missing or too-short next_action`);
    }
  }

  // 4. Summary check
  const summary = fs.readFileSync(
    path.join(workspaceRoot, 'legal-intake/matter-summary.md'), 'utf8');
  assert(summary.includes('Open'), 'summary must mention Open count');
  assert(summary.includes('Decline'), 'summary must mention Decline count');

  return { passed: true };
}
```

---

### Fixture 2: Customer Support Triage Plan — Detailed Design

#### Ambiguity and Edge Cases

**Edge case 1 — Feature request from enterprise customer:**
- Ticket says "Feature request: keyboard shortcuts"
- Customer is marked "Enterprise" in the ticket
- Real support might treat this as P2 (high-value customer) rather than P3.
- The fixture seeds one enterprise feature request.

**Edge case 2 — Intermittent issue with unclear scope:**
- Ticket says "Intermittent slowness on reports page"
- Unclear if "some users" or "all users"
- Real support might classify as P2 (investigate) rather than P1 (escalate).
- The fixture seeds one ambiguous-scope ticket.

**Edge case 3 — Security concern:**
- Ticket says "Possible data leak in export function"
- Not confirmed, but high potential impact.
- Real support might escalate as P1 for investigation even if unconfirmed.
- The fixture seeds one unconfirmed security concern.

**Edge case 4 — Duplicate ticket:**
- Two tickets about the same issue from different customers.
- Real support links them and assigns one owner.
- The fixture seeds one duplicate pair.

**Edge case 5 — Internal tool issue:**
- Ticket is from an internal employee, not a customer.
- Real support might route to Internal IT, not Customer Support.
- The fixture seeds one internal ticket.

#### Seed Data Generation Strategy

| Parameter | Default | Description |
|-----------|---------|-------------|
| `--count` | 10 | Number of tickets |
| `--p1-rate` | 0.2 | Fraction that are P1-worthy |
| `--enterprise-rate` | 0.3 | Fraction from enterprise customers |
| `--ambiguous-rate` | 0.1 | Fraction with ambiguous scope |
| `--security-rate` | 0.1 | Fraction with security concerns |
| `--duplicate-rate` | 0.1 | Fraction that are duplicates |
| `--internal-rate` | 0.1 | Fraction from internal employees |
| `--seed` | random | Random seed |

Template structure:
```
Subject: {subject}

Description: {description}

Customer: {customer_name} ({tier})
```

Priority signals embedded in subject and description:
- **P1**: "all users", "system down", "completely unavailable", "production outage", "data loss", "security"
- **P2**: "bug", "not working", "error", "failing", "intermittent", "slow"
- **P3**: "how do I", "question", "feature request", "request for", "timeline", "documentation"

The generator ensures that P1 tickets always contain at least one P1 signal, but some P2 tickets may contain ambiguous signals that require judgment.

#### Verifier Design

```javascript
function verifySupportTriage(workspaceRoot) {
  // 1. Coverage
  const inboxFiles = fs.readdirSync(path.join(workspaceRoot, 'support-inbox'))
    .filter(f => f.match(/ticket-\d{3}\.txt$/));
  const triagePlan = fs.readFileSync(
    path.join(workspaceRoot, 'support-queue/triage-plan.md'), 'utf8');

  for (const file of inboxFiles) {
    assert(triagePlan.includes(file.replace('.txt', '')),
      `triage plan missing ${file}`);
  }

  // 2. P1 accuracy
  for (const file of inboxFiles) {
    const content = fs.readFileSync(path.join(workspaceRoot, 'support-inbox', file), 'utf8');
    const ticketId = file.replace('.txt', '');
    const isP1Signal = /all users|system down|production outage|data loss/i.test(content);

    if (isP1Signal) {
      assert(triagePlan.includes(`${ticketId}`) && triagePlan.match(new RegExp(`${ticketId}.*P1|${ticketId}.*p1`, 'i')),
        `${ticketId} has P1 signal but not classified as P1`);
    }
  }

  // 3. Escalation list completeness
  const escalationList = fs.readFileSync(
    path.join(workspaceRoot, 'support-queue/escalation-list.md'), 'utf8');
  const p1TicketsInPlan = triagePlan.match(/P1/gi) || [];
  const p1TicketsInEscalation = escalationList.match(/ticket-\d{3}/gi) || [];

  // Every P1 in triage plan should appear in escalation list
  // (exact count check is tricky because a ticket may be mentioned multiple times)
  // So we check that escalation list is non-empty if there are P1s
  if (p1TicketsInPlan.length > 0) {
    assert(p1TicketsInEscalation.length > 0,
      'P1s exist in triage plan but escalation list is empty');
  }

  return { passed: true };
}
```

---

### Fixture 3: Vendor Compliance Decision Register — Detailed Design

#### Ambiguity and Edge Cases

**Edge case 1 — Certification expires within 6 months:**
- Vendor has valid SOC 2 cert, but it expires in 4 months.
- Policy says "conditional if expires within 6 months"
- Real compliance might approve with a calendar reminder, or conditional with a requirement to submit renewal evidence.
- The fixture seeds one vendor with near-expiry cert.

**Edge case 2 — Missing DPA but all else complete:**
- Vendor has profile and cert, but no DPA.
- Policy says "missing DPA = reject"
- Real compliance might allow a grace period if the DPA is in legal review.
- The fixture seeds one vendor with DPA "in review" (not missing, but not present).

**Edge case 3 — Incident is resolved:**
- Vendor had an incident 8 months ago, but it is marked "Resolved" with RCA published.
- Policy says "active incident = reject/review"
- Real compliance might treat resolved incidents differently.
- The fixture seeds one vendor with a resolved incident.

**Edge case 4 — Non-standard certification:**
- Vendor submits a PCI DSS report instead of SOC 2 or ISO 27001.
- Policy lists specific certifications.
- Real compliance might accept PCI DSS if the vendor processes payments, or might request the standard cert.
- The fixture seeds one vendor with an alternative cert.

**Edge case 5 — Vendor profile and DPA present, but cert is self-attestation:**
- Vendor says "We are SOC 2 compliant" but has no third-party report.
- Real compliance would reject or request the actual report.
- The fixture seeds one vendor with self-attestation.

#### Seed Data Generation Strategy

| Parameter | Default | Description |
|-----------|---------|-------------|
| `--vendor-count` | 5 | Number of vendors |
| `--complete-rate` | 0.4 | Fraction with all required docs |
| `--near-expiry-rate` | 0.2 | Fraction with cert expiring within 6 months |
| `--missing-dpa-rate` | 0.1 | Fraction missing DPA |
| `--resolved-incident-rate` | 0.1 | Fraction with resolved incident |
| `--alt-cert-rate` | 0.1 | Fraction with non-standard cert |
| `--self-attestation-rate` | 0.1 | Fraction with self-attestation |
| `--seed` | random | Random seed |

Vendor document templates:
```javascript
const CERT_TYPES = ['soc2', 'iso27001', 'pci-dss', 'self-attestation'];
const CERT_STATUSES = ['valid', 'expired', 'near-expiry'];
const INCIDENT_STATUSES = ['none', 'open', 'resolved'];
```

Policy documents are static templates that define the rules the agent must apply.

#### Verifier Design

```javascript
function verifyVendorCompliance(workspaceRoot) {
  // 1. Coverage
  const vendorDirs = fs.readdirSync(path.join(workspaceRoot, 'vendors/incoming'))
    .filter(d => d.startsWith('vendor-'));
  const register = parseCSV(path.join(workspaceRoot, 'vendors/vendor-decision-register.csv'));
  assert(register.length === vendorDirs.length,
    `Register has ${register.length} rows, expected ${vendorDirs.length}`);

  // 2. Policy alignment checks
  for (const row of register) {
    const vendorPath = path.join(workspaceRoot, 'vendors/incoming', row.vendor_id);
    const hasDPA = fs.existsSync(path.join(vendorPath, 'dpa.md'));
    const certFiles = fs.readdirSync(vendorPath).filter(f => f.includes('cert'));

    // Missing DPA should not be Approve
    if (!hasDPA && row.disposition === 'Approve') {
      assert(false, `${row.vendor_id}: missing DPA but approved`);
    }

    // Missing cert should not be Approve
    if (certFiles.length === 0 && row.disposition === 'Approve') {
      assert(false, `${row.vendor_id}: missing cert but approved`);
    }
  }

  // 3. Compliance review check
  const review = fs.readFileSync(
    path.join(workspaceRoot, 'vendors/compliance-review.md'), 'utf8');
  assert(review.includes('Executive summary') || review.includes('executive summary'),
    'compliance review missing executive summary');
  assert(review.includes('approved') || review.includes('Approved'),
    'compliance review missing approved count');
  assert(review.includes('rejected') || review.includes('Rejected'),
    'compliance review missing rejected count');

  return { passed: true };
}
```

---

### Fixture 4: Shared Drive Cleanup — Detailed Design

#### Ambiguity and Edge Cases

**Edge case 1 — File referenced by active project:**
- File is old (created 2024) but `active/sprint-23-goals.md` references it by name.
- Real cleanup would not archive a file that is actively referenced.
- The fixture seeds one stale file with an active reference.

**Edge case 2 — Partial duplicate:**
- Two files with similar content but one has an extra paragraph.
- Real cleanup might treat them as different documents.
- The fixture seeds one partial duplicate pair.

**Edge case 3 — File with date in name but current content:**
- Filename is `budget-2024-vs-2025.xlsx` but last modified is last week.
- Date in filename does not mean stale.
- Real cleanup uses mtime, not filename.
- The fixture seeds one file with a misleading date in the name.

**Edge case 4 — Archive folder already exists with content:**
- Previous cleanup already moved some files to `archive/`.
- Current cleanup must not overwrite or lose the existing archive.
- The fixture seeds an existing `archive/` folder.

**Edge case 5 — Symlinks or shortcuts:**
- File is a symlink to another file.
- Real cleanup would handle symlinks differently (follow or skip).
- The fixture seeds one symlink (if the substrate supports it).

#### Seed Data Generation Strategy

| Parameter | Default | Description |
|-----------|---------|-------------|
| `--file-count` | 500 | Total files |
| `--duplicate-rate` | 0.04 | Fraction that are duplicates |
| `--stale-rate` | 0.06 | Fraction that are stale |
| `--inconsistent-rate` | 0.04 | Fraction with naming inconsistency |
| `--active-reference-rate` | 0.02 | Fraction of stale files with active references |
| `--partial-duplicate-rate` | 0.02 | Fraction of duplicates that are partial |
| `--pre-existing-archive` | false | Whether archive/ already exists |
| `--seed` | random | Random seed |

File generation strategy:
1. Generate `file-count` files across multiple folders
2. Mark some as "active" (recent mtime, standard naming)
3. Create duplicates by copying content of some active files with variant names
4. Create stale files by backdating mtime and/or including old year in filename
5. Create inconsistent files by using underscore_case variants
6. Inject active references to some stale files
7. Optionally pre-populate `archive/` with previous cleanup results

#### Verifier Design

```javascript
function verifySharedDriveCleanup(workspaceRoot) {
  const drivePath = path.join(workspaceRoot, 'shared-drive');

  // 1. Folders exist
  assert(fs.existsSync(path.join(drivePath, 'archive')));
  assert(fs.existsSync(path.join(drivePath, 'duplicates')));
  assert(fs.existsSync(path.join(drivePath, 'normalized')));

  // 2. Report and log exist
  assert(fs.existsSync(path.join(drivePath, 'migration-report.md')));
  assert(fs.existsSync(path.join(drivePath, 'cleanup-log.csv')));

  const report = fs.readFileSync(path.join(drivePath, 'migration-report.md'), 'utf8');
  const log = parseCSV(path.join(drivePath, 'cleanup-log.csv'));

  // 3. Every file in log has a corresponding entry
  for (const entry of log) {
    assert(fs.existsSync(path.join(drivePath, entry.original_path)),
      `log references non-existent original: ${entry.original_path}`);
    assert(fs.existsSync(path.join(drivePath, entry.new_path)),
      `log references non-existent new path: ${entry.new_path}`);
  }

  // 4. Active files should remain in place (check a sample)
  const activeFiles = ['active/sprint-23-goals.md', 'active/current-roadmap.md'];
  for (const f of activeFiles) {
    assert(fs.existsSync(path.join(drivePath, f)),
      `active file should remain: ${f}`);
  }

  // 5. No files deleted (check total count)
  const totalFilesBefore = countFiles(drivePath, { exclude: ['archive', 'duplicates', 'normalized'] });
  const totalFilesAfter = countFiles(drivePath);
  // Total should be >= before (some files moved to new folders, but none lost)
  assert(totalFilesAfter >= totalFilesBefore - 5, // allow small margin for symlinks/shortcuts
    `files may have been deleted: ${totalFilesBefore} before, ${totalFilesAfter} after`);

  return { passed: true };
}
```

---

## Scale Parameters Summary

| Fixture | Default Items | Range | Scale Knobs |
|---------|--------------|-------|-------------|
| Legal Intake | 10 forms | 5–50 | `--count`, `--complete-rate`, `--critical-urgency-rate` |
| Customer Support | 10 tickets | 5–50 | `--count`, `--p1-rate`, `--enterprise-rate` |
| Vendor Compliance | 5 vendors | 3–30 | `--vendor-count`, `--complete-rate`, `--near-expiry-rate` |
| Shared Drive Cleanup | 500 files | 200–2000 | `--file-count`, `--duplicate-rate`, `--stale-rate` |

---

## Determinism and Repeatability

All fixture generators:
1. Accept a `--seed` parameter for deterministic random number generation
2. Log the seed used so runs can be reproduced
3. Use template interpolation rather than LLM generation for content
4. Produce identical output given the same seed and parameters
5. Include a `fixture-manifest.json` in the workspace root documenting:
   - generator version
   - seed used
   - parameters
   - timestamp
   - file count and checksums

---

## Fixture Lifecycle

1. **Generate** — run generator script with parameters
2. **Apply** — POST to `/api/workspace/fixture` or write directly to workspace
3. **Execute** — create ticket with objective, agent runs
4. **Verify** — run verifier script against workspace
5. **Record** — store results, replay snapshot, and verifier output
6. **Regenerate** — if needed, same seed produces identical fixture for reproduction

---

## Objective Templates

Each fixture requires a ticket objective that communicates the business goal without scripting the agent's steps. The agent should decide *how* to produce the output.

### Legal Intake Objective

```
I am a legal operations manager. I need to process the intake forms in legal-intake/incoming/.

For each intake form:
1. Read the form
2. Decide: Open the matter, Request more information, or Decline
3. Create legal-intake/intake-register.csv with all intakes and decisions
4. Create legal-intake/matter-summary.md with a summary for my team lead

Check these fields on each form:
- Matter Type
- Requesting Party
- Contact Email
- Jurisdiction
- Description

Open the matter if all required fields are present.
Request more information if only optional fields are missing.
Decline if a required field is missing or the request is outside legal scope.
```

### Customer Support Objective

```
I am a support team lead. I need to triage the tickets in support-inbox/.

For each ticket:
1. Read the ticket
2. Determine priority (P1/P2/P3), assignee team, and whether escalation is needed
3. Create support-queue/triage-plan.md with all tickets and assignments
4. Create support-queue/escalation-list.md for immediate on-call handoff

Priority guidelines:
- P1: system outage, all users affected, data loss, security concern
- P2: functional bug, intermittent issue, performance problem
- P3: question, feature request, documentation

Assignee guidelines:
- Bugs → Engineering
- Questions → Customer Success
- Feature requests → Product
- P1 → On-Call immediately

Consider customer tier when classifying. Enterprise customers may warrant higher priority.
```

### Vendor Compliance Objective

```
I am a procurement compliance officer. I need to review vendor packets in vendors/incoming/.

For each vendor:
1. Read the vendor profile, DPA, and any security certification
2. Read policies/vendor-onboarding-policy.md for approval rules
3. Decide: Approve, Conditional Approve, or Reject
4. Create vendors/vendor-decision-register.csv with all decisions
5. Create vendors/compliance-review.md for audit documentation

Policy rules (from vendors/vendor-onboarding-policy.md):
- All required documents must be present (profile, DPA, valid certification)
- Certification must be current (not expired) and from an approved type
- Active security incidents require review
- Document exceptions clearly with policy references
```

### Shared Drive Cleanup Objective

```
I am an IT administrator. I need to clean up shared-drive/ for storage optimization.

Rules:
1. Find duplicate files (same content, different names). Move duplicates to shared-drive/duplicates/
2. Find stale files (last modified >12 months ago or filename implies old date). Move to shared-drive/archive/
3. Find naming inconsistencies (underscores instead of hyphens, mixed case). Rename to kebab-case and move to shared-drive/normalized/
4. Leave current/active files in place
5. Create shared-drive/migration-report.md documenting all actions
6. Create shared-drive/cleanup-log.csv for audit and rollback

Do not delete any files. Only move or rename.
```

---

## Expected Agent Behavior

### Legal Intake — Expected Workflow

1. `listDirectory` — discover the incoming folder and any existing output path
2. `readFile` for each intake form (10 forms, ~10 reads)
3. `writeFile` — produce `intake-register.csv` with structured data
4. `writeFile` — produce `matter-summary.md` with narrative summary
5. `complete: true` — signal completion

**Expected model requests:** 4–6 (one to explore, one to read, two to write, one to complete)

**Risks:**
- Agent reads every form one at a time rather than listing and reading in batches
- Agent creates extra files (per-intake summaries, temp working files)
- Agent mistypes CSV column headers

### Customer Support — Expected Workflow

1. `listDirectory` — discover the inbox
2. `readFile` for each ticket (10 tickets, ~10 reads)
3. `writeFile` — produce `triage-plan.md`
4. `writeFile` — produce `escalation-list.md`
5. `complete: true`

**Expected model requests:** 4–6

**Risks:**
- Agent classifies enterprise feature request as P3 instead of P2
- Agent misses ambiguous P1 signal (e.g., "possible data leak" → should escalate)
- Agent creates the triage plan but omits the escalation list

### Vendor Compliance — Expected Workflow

1. `listDirectory` — discover vendor folders and policies
2. `readFile` — policies to understand rules
3. `readFile` for each vendor packet (profile, DPA, cert)
4. `writeFile` — `vendor-decision-register.csv`
5. `writeFile` — `compliance-review.md`
6. `complete: true`

**Expected model requests:** 6–10 (more because policies must be read before vendor decisions)

**Risks:**
- Agent makes decisions without reading the policy first
- Agent misreads certification expiry dates
- Agent does not cross-reference incident records
- Agent hallucinates policy clauses

### Shared Drive Cleanup — Expected Workflow

1. `listDirectory` — explore the drive structure (may take several calls due to limits)
2. `readFile` — sample files to detect duplicates and content dates
3. `createFolder` — `archive/`, `duplicates/`, `normalized/`
4. `renamePath` — batch moves (one per file)
5. `writeFile` — `migration-report.md`
6. `writeFile` — `cleanup-log.csv`
7. `complete: true`

**Expected model requests:** 8–15 (most complex fixture)

**Risks:**
- Agent hits `maxListDirectory` limit before exploring the full structure
- Agent attempts to read every file (500+ reads) and fails budget
- Agent cannot distinguish stale from current files without last-modified metadata
- Agent duplicates or simplifies file paths in the log

---

## Failure Mode Catalog

### Classification Failures

| Mode | Fixtures | Detection | Root Cause |
|------|----------|-----------|------------|
| Over-classification | All | Agent assigns a disposition to a file that does not exist | Hallucination |
| Under-classification | All | Some source files omitted from output | Coverage gap in read phase |
| Misclassification | Legal, Support, Vendor | Disposition contradicts content | Rule misunderstanding |
| Priority inversion | Support | P1 signal present but classified as P2 | Keyword missed or judgment failure |

### Artifact Failures

| Mode | Fixtures | Detection | Root Cause |
|------|----------|-----------|------------|
| Missing required artifact | All | Expected file not created | Agent forgot step or hit step limit |
| Extra unintended artifacts | All | Files created that are not in spec | Agent over-produced |
| Malformed CSV | Legal, Vendor | CSV cannot be parsed (missing headers, wrong columns) | Agent guessed format |
| Summary too short | Legal, Support, Vendor | Summary has insufficient detail for human handoff | Agent prioritized brevity over completeness |

### Execution Failures

| Mode | Fixtures | Detection | Root Cause |
|------|----------|-----------|------------|
| Step limit exceeded | All | Run terminated with `RUN_LIMIT_EXCEEDED` | Too many model requests (reading one file at a time) |
| Operation limit exceeded | All | Run terminated with operation limit | Too many `listDirectory` or `readFile` calls |
| No progress | All | Run terminated for repeated inspection without mutation | Agent could not reach a decision |
| Timeout | Large, Cleanup | Run terminated for exceeding max duration | Too many files to process within time budget |

### Cleanup-Specific Failures

| Mode | Detection | Root Cause |
|------|-----------|------------|
| File deleted instead of moved | File count decreased | Agent used wrong operation |
| Active file archived | Active file detected in archive/ | Agent misidentified staleness signal |
| Duplicate kept, original moved | Wrong file in archive/duplicates/ | Agent applied incorrect dedup rule |
| Naming rename creates name collision | `normalized/` has two files with same target name | Two inconsistent files normalize to the same name |

---

## Postcondition Definitions

Structural postconditions for each fixture. These are deterministic checks that an independent verifier can run after the agent completes.

### Legal Intake Postconditions

```javascript
{
  "requiredFiles": [
    "legal-intake/intake-register.csv",
    "legal-intake/matter-summary.md"
  ],
  "requiredColumns": [
    "intake_id", "matter_type", "requesting_party",
    "disposition", "reason", "next_action"
  ],
  "coverageCheck": true,  // every incoming/ file appears in CSV
  "consistencyCheck": true // dispositions match form content
}
```

### Customer Support Postconditions

```javascript
{
  "requiredFiles": [
    "support-queue/triage-plan.md",
    "support-queue/escalation-list.md"
  ],
  "escalationCheck": true,  // P1s appear in both files
  "coverageCheck": true     // every inbox ticket appears in triage plan
}
```

### Vendor Compliance Postconditions

```javascript
{
  "requiredFiles": [
    "vendors/vendor-decision-register.csv",
    "vendors/compliance-review.md"
  ],
  "requiredColumns": [
    "vendor_id", "vendor_name", "disposition",
    "reason", "policy_reference", "next_action"
  ],
  "coverageCheck": true,
  "policyCheck": true  // dispositions align with policy rules
}
```

### Shared Drive Cleanup Postconditions

```javascript
{
  "requiredFolders": [
    "shared-drive/archive",
    "shared-drive/duplicates",
    "shared-drive/normalized"
  ],
  "requiredFiles": [
    "shared-drive/migration-report.md",
    "shared-drive/cleanup-log.csv"
  ],
  "noDeletionCheck": true,  // total file count is preserved
  "activePreservationCheck": true  // active files not moved
}
```


