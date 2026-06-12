# Business Workspace Fixture Plan — Routed Work Edition

## Design Principle

Business fixtures must require **operational state changes**, not only document synthesis.

Each fixture presents files in an input state. The agent must inspect them, apply business rules, and mutate the workspace by creating folders, moving files, and writing summaries. The final tree is the evidence of correct execution.

---

## Priority Order for Implementation

1. **Legal Intake Routing** (medium — best balance of complexity and clarity)
2. **Vendor Compliance Review** (large — cross-domain reconciliation)
3. **Customer Support Queue** (small — simple classification + routing)
4. **Shared Drive Cleanup** (large ops — duplicate detection, normalization)

---

## Tier 1: Legal Intake Routing (Medium — Priority 1)

### Business Scenario
A legal operations team receives intake forms from business units. Each form describes a legal matter (contract review, dispute, compliance question, NDA request). The team must:
- Read each intake form
- Determine if it is accepted (has all required fields), rejected (missing critical info), or needs followup (incomplete but salvageable)
- Move the file to the appropriate folder
- Produce a routing summary

### Input Fixture Structure
```
workspace-root/
└── legal-intake/
    └── incoming/
        ├── intake-2026-001.md    (complete — contract review)
        ├── intake-2026-002.md    (incomplete — missing party name)
        ├── intake-2026-003.md    (complete — NDA request)
        ├── intake-2026-004.md    (incomplete — missing jurisdiction)
        ├── intake-2026-005.md    (complete — compliance question)
        ├── intake-2026-006.md    (incomplete — vague description, needs clarification)
        ├── intake-2026-007.md    (complete — dispute)
        ├── intake-2026-008.md    (incomplete — missing contact email)
        ├── intake-2026-009.md    (complete — contract review)
        └── intake-2026-010.md    (incomplete — missing matter type)
```

### Seed Data Strategy

Each intake file follows a structured markdown template with clear field labels.

**Complete example (intake-2026-001.md):**
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
Review SaaS subscription agreement for renewal. Concerns: liability cap, data processing addendum.

## Urgency
Standard (2-week turnaround)
```

**Incomplete example (intake-2026-002.md):**
```markdown
# Legal Intake Form

## Matter Type
Contract Review

## Requesting Party
[MISSING]

## Contact Email
procurement@globex.example.com

## Jurisdiction
California, USA

## Description
Review vendor agreement for cloud hosting services.

## Urgency
Standard
```

**Routing rules for the agent (embedded in ticket objective):**
- **Accepted**: all required fields present (Matter Type, Requesting Party, Contact Email, Jurisdiction, Description)
- **Rejected**: missing Requesting Party OR missing Matter Type (cannot proceed)
- **Needs Followup**: missing Jurisdiction OR missing Description OR missing Contact Email (salvageable with one email)

### Ticket Objective
```
Read all files in legal-intake/incoming/. For each intake form:
1. Check if all required fields are present: Matter Type, Requesting Party, Contact Email, Jurisdiction, Description
2. If Requesting Party or Matter Type is missing, route to legal-intake/rejected/
3. If Jurisdiction, Description, or Contact Email is missing (but Party and Type exist), route to legal-intake/needs-followup/
4. Otherwise, route to legal-intake/accepted/
5. Create the three folders if they do not exist
6. Move each file to its destination folder
7. Write legal-intake/intake-summary.md listing: file name | routed to | reason
```

### Expected Mutations
1. `createFolder` — `legal-intake/accepted/`
2. `createFolder` — `legal-intake/rejected/`
3. `createFolder` — `legal-intake/needs-followup/`
4. `renamePath` — move each intake file from `incoming/` to its routed folder
5. `writeFile` — `legal-intake/intake-summary.md`

### Expected Final Tree
```
workspace-root/
└── legal-intake/
    ├── incoming/                    (empty or remaining unprocessed)
    ├── accepted/
    │   ├── intake-2026-001.md
    │   ├── intake-2026-003.md
    │   ├── intake-2026-005.md
    │   ├── intake-2026-007.md
    │   └── intake-2026-009.md
    ├── rejected/
    │   ├── intake-2026-002.md
    │   └── intake-2026-010.md
    ├── needs-followup/
    │   ├── intake-2026-004.md
    │   ├── intake-2026-006.md
    │   └── intake-2026-008.md
    └── intake-summary.md
```

### Deterministic Verifier
```javascript
function verifyLegalIntakeFixture(workspaceRoot) {
  const fs = require('fs');
  const path = require('path');
  const assert = (v, msg) => { if (!v) throw new Error(msg); };

  const base = path.join(workspaceRoot, 'legal-intake');
  assert(fs.existsSync(path.join(base, 'accepted')), 'accepted folder missing');
  assert(fs.existsSync(path.join(base, 'rejected')), 'rejected folder missing');
  assert(fs.existsSync(path.join(base, 'needs-followup')), 'needs-followup folder missing');
  assert(fs.existsSync(path.join(base, 'intake-summary.md')), 'summary missing');

  const summary = fs.readFileSync(path.join(base, 'intake-summary.md'), 'utf8');
  const routedFiles = [];
  for (const folder of ['accepted', 'rejected', 'needs-followup']) {
    const folderPath = path.join(base, folder);
    if (!fs.existsSync(folderPath)) continue;
    const files = fs.readdirSync(folderPath).filter(f => f.endsWith('.md'));
    routedFiles.push(...files.map(f => ({ file: f, folder })));
  }

  // All 10 intake files must be routed
  assert(routedFiles.length === 10, `expected 10 routed files, got ${routedFiles.length}`);

  // Check deterministic routing for seeded files
  const accepted = routedFiles.filter(r => r.folder === 'accepted').map(r => r.file);
  const rejected = routedFiles.filter(r => r.folder === 'rejected').map(r => r.file);
  const followup = routedFiles.filter(r => r.folder === 'needs-followup').map(r => r.file);

  assert(accepted.includes('intake-2026-001.md'), '001 should be accepted');
  assert(rejected.includes('intake-2026-002.md'), '002 should be rejected (missing party)');
  assert(accepted.includes('intake-2026-003.md'), '003 should be accepted');
  assert(followup.includes('intake-2026-004.md'), '004 should be followup (missing jurisdiction)');
  assert(accepted.includes('intake-2026-005.md'), '005 should be accepted');
  assert(followup.includes('intake-2026-006.md'), '006 should be followup (vague)');
  assert(accepted.includes('intake-2026-007.md'), '007 should be accepted');
  assert(followup.includes('intake-2026-008.md'), '008 should be followup (missing email)');
  assert(accepted.includes('intake-2026-009.md'), '009 should be accepted');
  assert(rejected.includes('intake-2026-010.md'), '010 should be rejected (missing type)');

  // Summary must reference all files
  for (const f of routedFiles.map(r => r.file)) {
    assert(summary.includes(f), `summary must reference ${f}`);
  }

  return { passed: true, routedCount: routedFiles.length };
}
```

### Scale Knobs
| Parameter | Default | Range |
|-----------|---------|-------|
| Intake count | 10 | 5–50 |
| Routing categories | 3 | 2–5 |
| Required fields | 5 | 3–8 |
| Include urgency field | yes | yes/no |
| Include priority override | no | yes/no |

### Workload Profile
Matches `refactor` profile (inspection + folder creation + file moves).

---

## Tier 2: Vendor Compliance Review (Large — Priority 2)

### Business Scenario
A procurement compliance team reviews vendor packets. Each vendor submits a packet containing: a profile, a data processing agreement, a security certification, and references to applicable company policies. The team must:
- Read each vendor packet
- Check if the packet is complete (all required documents present)
- Compare vendor certifications against policy requirements
- Check if any incidents are associated with the vendor
- Route the vendor to approved, rejected, or needs-review
- Produce an audit findings report

### Input Fixture Structure
```
workspace-root/
├── vendors/
│   └── incoming/
│       ├── vendor-alpha/
│       │   ├── vendor-profile.md
│       │   ├── dpa.md
│       │   └── soc2-cert.md
│       ├── vendor-beta/
│       │   ├── vendor-profile.md
│       │   └── dpa.md               ← missing cert
│       ├── vendor-gamma/
│       │   ├── vendor-profile.md
│       │   ├── dpa.md
│       │   └── soc2-cert.md         ← expired cert
│       ├── vendor-delta/
│       │   ├── vendor-profile.md
│       │   ├── dpa.md
│       │   └── iso27001-cert.md
│       └── vendor-epsilon/
│           ├── vendor-profile.md
│           ├── dpa.md
│           └── soc2-cert.md
├── policies/
│   ├── vendor-onboarding-policy.md
│   ├── data-processing-requirements.md
│   └── security-certification-requirements.md
├── certifications/
│   └── (reference only — not vendor-specific)
└── incidents/
    └── incident-2026-001.md         ← references vendor-gamma
```

### Seed Data Strategy

**Vendor profile template:**
```markdown
# Vendor Profile: Alpha Cloud Services

## Vendor ID
ALPHA-2026

## Service Category
Cloud Infrastructure

## Contact
compliance@alpha.example.com

## Submitted Date
2026-01-15
```

**Policy requirements (vendor-onboarding-policy.md):**
```markdown
# Vendor Onboarding Policy

## Required Documents
- Vendor profile
- Data processing agreement (DPA)
- Valid security certification (SOC 2 Type II or ISO 27001)

## Rejection Conditions
- Missing DPA
- Missing security certification
- Certification expired before 2026-01-01

## Needs Review Conditions
- Certification expires within 6 months
- Incident record exists for vendor in past 12 months
- Non-standard service category

## Approval Conditions
- All required documents present
- Certification valid and not expiring soon
- No active incidents
```

**Incident record (incident-2026-001.md):**
```markdown
# Security Incident Report

## Incident ID
INC-2026-001

## Vendor
Vendor Gamma (GAMMA-2026)

## Date
2026-02-10

## Description
Unauthorized access to staging environment. Under investigation.

## Status
Open
```

**Certification files embed validity:**
```markdown
# SOC 2 Type II Report

## Vendor
Alpha Cloud Services

## Certification Date
2025-06-01

## Expiry Date
2026-06-01

## Status
Valid
```

### Ticket Objective
```
Review all vendor packets in vendors/incoming/. For each vendor:
1. Read the vendor profile, DPA, and any certification
2. Read the vendor-onboarding-policy to understand requirements
3. Determine routing:
   - APPROVED: all docs present, cert valid and not expiring before 2026-07-01, no incidents
   - REJECTED: missing DPA, missing cert, or cert expired before 2026-01-01
   - NEEDS REVIEW: cert expires before 2026-07-01, or incident record exists, or non-standard category
4. Create vendors/approved/, vendors/rejected/, vendors/needs-review/
5. Move each vendor folder to its destination
6. Write vendors/audit-findings.md with:
   - Executive summary (counts)
   - Per-vendor finding with rule violated or satisfied
   - Recommended action for needs-review items
```

### Expected Mutations
1. `createFolder` — `vendors/approved/`
2. `createFolder` — `vendors/rejected/`
3. `createFolder` — `vendors/needs-review/`
4. `renamePath` — move each vendor folder from `incoming/` to destination
5. `writeFile` — `vendors/audit-findings.md`

### Expected Final Tree
```
workspace-root/
├── vendors/
│   ├── incoming/                    (empty)
│   ├── approved/
│   │   ├── vendor-alpha/
│   │   └── vendor-epsilon/
│   ├── rejected/
│   │   ├── vendor-beta/             (missing cert)
│   │   └── vendor-gamma/            (expired cert + incident)
│   ├── needs-review/
│   │   └── vendor-delta/            (cert expires soon or non-standard)
│   └── audit-findings.md
├── policies/
└── incidents/
```

### Deterministic Verifier
```javascript
function verifyVendorComplianceFixture(workspaceRoot) {
  const fs = require('fs');
  const path = require('path');
  const assert = (v, msg) => { if (!v) throw new Error(msg); };

  const vendorsPath = path.join(workspaceRoot, 'vendors');
  assert(fs.existsSync(path.join(vendorsPath, 'approved')), 'approved folder missing');
  assert(fs.existsSync(path.join(vendorsPath, 'rejected')), 'rejected folder missing');
  assert(fs.existsSync(path.join(vendorsPath, 'needs-review')), 'needs-review folder missing');
  assert(fs.existsSync(path.join(vendorsPath, 'audit-findings.md')), 'audit findings missing');

  const summary = fs.readFileSync(path.join(vendorsPath, 'audit-findings.md'), 'utf8');

  // All 5 vendor folders must be routed
  const routedVendors = [];
  for (const folder of ['approved', 'rejected', 'needs-review']) {
    const folderPath = path.join(vendorsPath, folder);
    if (!fs.existsSync(folderPath)) continue;
    const subs = fs.readdirSync(folderPath).filter(f => f.startsWith('vendor-'));
    routedVendors.push(...subs.map(s => ({ vendor: s, folder })));
  }
  assert(routedVendors.length === 5, `expected 5 routed vendors, got ${routedVendors.length}`);

  // Deterministic checks for seeded data
  const approved = routedVendors.filter(r => r.folder === 'approved').map(r => r.vendor);
  const rejected = routedVendors.filter(r => r.folder === 'rejected').map(r => r.vendor);
  const review = routedVendors.filter(r => r.folder === 'needs-review').map(r => r.vendor);

  assert(approved.includes('vendor-alpha'), 'alpha should be approved (complete, valid cert, no incident)');
  assert(rejected.includes('vendor-beta'), 'beta should be rejected (missing cert)');
  assert(rejected.includes('vendor-gamma'), 'gamma should be rejected (expired cert + incident)');
  assert(review.includes('vendor-delta'), 'delta should be needs-review (ISO27001 non-standard or expires soon)');
  assert(approved.includes('vendor-epsilon'), 'epsilon should be approved');

  // Summary must reference all vendors
  for (const v of routedVendors.map(r => r.vendor)) {
    assert(summary.includes(v), `summary must reference ${v}`);
  }

  return { passed: true, routedCount: routedVendors.length };
}
```

### Scale Knobs
| Parameter | Default | Range |
|-----------|---------|-------|
| Vendor count | 5 | 3–30 |
| Documents per vendor | 3 | 2–5 |
| Policy count | 3 | 1–8 |
| Incident count | 1 | 0–10 |
| Certification types | 2 | 1–4 |
| Include sub-vendor items | no | yes/no |

### Workload Profile
Matches `refactor` profile with elements of `report` (the findings document).

---

## Tier 3: Customer Support Queue (Small — Priority 3)

### Business Scenario
A support team lead triages 10 incoming tickets by priority. Each ticket is a text file. The lead must:
- Read each ticket
- Determine priority: P1 (critical/system down), P2 (bug/functional issue), P3 (question/feature request)
- Create priority folders
- Move ticket files into the correct folder
- Write an assignments summary

### Input Fixture Structure
```
workspace-root/
└── support-inbox/
    ├── ticket-001.txt   "Subject: Payment API returning 500s for all users since 09:00 UTC..."
    ├── ticket-002.txt   "Subject: Dark mode toggle not persisting across sessions..."
    ├── ticket-003.txt   "Subject: How do I export a report to PDF?..."
    ├── ticket-004.txt   "Subject: Database replication lag causing stale dashboard data..."
    ├── ticket-005.txt   "Subject: Feature request: keyboard shortcuts for navigation..."
    ├── ticket-006.txt   "Subject: Login page shows generic error for invalid credentials..."
    ├── ticket-007.txt   "Subject: All file uploads failing with timeout..."
    ├── ticket-008.txt   "Subject: Question about supported browser versions..."
    ├── ticket-009.txt   "Subject: Memory leak in background job worker..."
    └── ticket-010.txt   "Subject: Request for SSO integration timeline..."
```

### Seed Data Strategy

Each ticket file has:
- Subject line with clear priority signal
- Brief description
- Priority keywords embedded:
  - **P1 signals**: "all users", "system down", "completely unavailable", "critical", "production outage", "data loss"
  - **P2 signals**: "bug", "not working", "error", "failing", "intermittent", "stale", "memory leak", "slow"
  - **P3 signals**: "how do I", "question", "feature request", "request for", "timeline", "documentation"

**Example P1 (ticket-001.txt):**
```
Subject: Payment API returning 500s for all users since 09:00 UTC

Description: Since 09:00 UTC today, all payment processing requests
return HTTP 500. Affecting all customers globally. Revenue impact.
```

**Example P2 (ticket-002.txt):**
```
Subject: Dark mode toggle not persisting across sessions

Description: Users select dark mode in settings, but after logging
out and back in, the theme reverts to light mode.
```

**Example P3 (ticket-003.txt):**
```
Subject: How do I export a report to PDF?

Description: I can see the export button but I don't see PDF as an
option. Is this supported?
```

### Ticket Objective
```
Read all files in support-inbox/. For each ticket:
1. Classify priority based on content:
   - P1: system-wide outage, data loss, complete unavailability
   - P2: functional bug, performance issue, intermittent failure
   - P3: question, feature request, documentation
2. Create support-queue/p1/, support-queue/p2/, support-queue/p3/
3. Move each ticket file to the correct priority folder
4. Write support-queue/assignments.md with:
   - Table: ticket file | priority | subject | suggested assignee role
   - P1 items flagged for immediate escalation
```

### Expected Mutations
1. `createFolder` — `support-queue/`
2. `createFolder` — `support-queue/p1/`
3. `createFolder` — `support-queue/p2/`
4. `createFolder` — `support-queue/p3/`
5. `renamePath` — move each ticket from `support-inbox/` to `support-queue/pN/`
6. `writeFile` — `support-queue/assignments.md`

### Expected Final Tree
```
workspace-root/
├── support-inbox/                   (empty)
└── support-queue/
    ├── p1/
    │   ├── ticket-001.txt
    │   ├── ticket-004.txt
    │   └── ticket-007.txt
    ├── p2/
    │   ├── ticket-002.txt
    │   ├── ticket-006.txt
    │   └── ticket-009.txt
    ├── p3/
    │   ├── ticket-003.txt
    │   ├── ticket-005.txt
    │   ├── ticket-008.txt
    │   └── ticket-010.txt
    └── assignments.md
```

### Deterministic Verifier
```javascript
function verifySupportQueueFixture(workspaceRoot) {
  const fs = require('fs');
  const path = require('path');
  const assert = (v, msg) => { if (!v) throw new Error(msg); };

  const queuePath = path.join(workspaceRoot, 'support-queue');
  assert(fs.existsSync(path.join(queuePath, 'p1')), 'p1 folder missing');
  assert(fs.existsSync(path.join(queuePath, 'p2')), 'p2 folder missing');
  assert(fs.existsSync(path.join(queuePath, 'p3')), 'p3 folder missing');
  assert(fs.existsSync(path.join(queuePath, 'assignments.md')), 'assignments missing');

  const assignments = fs.readFileSync(path.join(queuePath, 'assignments.md'), 'utf8');

  // Count routed tickets
  let routedCount = 0;
  for (const folder of ['p1', 'p2', 'p3']) {
    const folderPath = path.join(queuePath, folder);
    if (!fs.existsSync(folderPath)) continue;
    routedCount += fs.readdirSync(folderPath).filter(f => f.endsWith('.txt')).length;
  }
  assert(routedCount === 10, `expected 10 routed tickets, got ${routedCount}`);

  // Check deterministic placements for seeded data
  const p1Files = fs.readdirSync(path.join(queuePath, 'p1')).filter(f => f.endsWith('.txt'));
  const p2Files = fs.readdirSync(path.join(queuePath, 'p2')).filter(f => f.endsWith('.txt'));
  const p3Files = fs.readdirSync(path.join(queuePath, 'p3')).filter(f => f.endsWith('.txt'));

  assert(p1Files.includes('ticket-001.txt'), '001 should be P1 (system-wide outage)');
  assert(p1Files.includes('ticket-007.txt'), '007 should be P1 (all uploads failing)');
  assert(p2Files.includes('ticket-002.txt'), '002 should be P2 (bug)');
  assert(p2Files.includes('ticket-009.txt'), '009 should be P2 (memory leak)');
  assert(p3Files.includes('ticket-003.txt'), '003 should be P3 (question)');
  assert(p3Files.includes('ticket-010.txt'), '010 should be P3 (feature request)');

  // Assignments must reference all tickets
  for (let i = 1; i <= 10; i++) {
    const fileName = `ticket-${String(i).padStart(3, '0')}.txt`;
    assert(assignments.includes(fileName), `assignments must reference ${fileName}`);
  }

  return { passed: true, routedCount };
}
```

### Scale Knobs
| Parameter | Default | Range |
|-----------|---------|-------|
| Ticket count | 10 | 5–30 |
| Priority levels | 3 | 2–5 |
| Include duplicate tickets | no | yes/no |
| Include resolved/closed folder | no | yes/no |

### Workload Profile
Matches `refactor` profile (classification + folder creation + file moves).

---

## Tier 4: Shared Drive Cleanup (Large Ops — Priority 4)

### Business Scenario
An IT administrator needs to clean up a shared drive containing 500+ files accumulated over 2 years. The drive has:
- Duplicate files with different names
- Files with inconsistent naming conventions
- Stale files (not modified in 12+ months)
- Files in wrong folders

The administrator must:
- Scan the drive structure
- Identify duplicates, stale files, and naming inconsistencies
- Move duplicates to `duplicates/`
- Move stale files to `archive/`
- Rename inconsistent files and move to `normalized/`
- Leave current/active files in place
- Produce a migration report

### Input Fixture Structure
```
workspace-root/
└── shared-drive/
    ├── project-alpha/
    │   ├── spec-v1.md
    │   ├── spec_v2.md                  ← naming inconsistency (underscore vs hyphen)
    │   ├── meeting-notes-jan-2025.txt
    │   ├── meeting_notes_feb_2025.txt ← naming inconsistency
    │   └── report-Q1-2025.pdf        ← stale (>12 months)
    ├── project-beta/
    │   ├── README.md
    │   ├── readme.md                 ← duplicate (case difference)
    │   ├── deploy-script.sh
    │   └── deploy_script.sh          ← duplicate (underscore vs hyphen)
    ├── misc/
    │   ├── temp-backup-2024-06.tar   ← stale
    │   ├── temp_backup_2024_07.tar   ← stale + naming inconsistency
    │   └── scratchpad.txt
    ├── active/
    │   ├── sprint-23-goals.md        ← current
    │   └── current-roadmap.md        ← current
    └── (additional folders/files to reach 500+ total)
```

### Seed Data Strategy

**Duplicates:**
- Same content, different filenames (case variants, hyphen vs underscore, version suffixes)
- Example: `README.md` and `readme.md` with identical content
- Example: `deploy-script.sh` and `deploy_script.sh` with identical content

**Stale files:**
- Filename includes old date: `temp-backup-2024-06.tar`
- Content mentions old dates: "Sprint 12, June 2024"
- Deterministically placed in folders with "2024" in the name or content

**Naming inconsistencies:**
- Hyphen vs underscore: `spec-v1.md` vs `spec_v1.md`
- Mixed case: `README.md` vs `readme.md`
- Inconsistent date formats: `2025-01-15` vs `jan-15-2025`

**Active files:**
- Recent dates in content: "Sprint 23, May 2026"
- No version duplicates
- Standard naming (kebab-case)

### Ticket Objective
```
Clean up the shared-drive/ folder. Follow these rules:

1. Identify duplicate files (same content, different names). Move the duplicate
   (not the first-seen variant) to duplicates/. Keep the original in place.

2. Identify stale files: any file whose name contains a date from 2024 or earlier,
   or whose content explicitly mentions a date before 2025-06-01. Move these to archive/.

3. Identify naming inconsistencies: files using underscores instead of hyphens,
   or mixed case variants of the same base name. Rename the inconsistent file
   to kebab-case and move to normalized/. Keep the kebab-case original in place.

4. Do NOT move files that are current (recent dates, standard naming, no duplicates).

5. Create duplicates/, archive/, and normalized/ folders.

6. Write shared-drive/migration-report.md with:
   - Count of files moved per category
   - List of each moved file with original path and new path
   - List of files renamed with old name and new name
   - Any files that could not be categorized
```

### Expected Mutations
1. `createFolder` — `shared-drive/duplicates/`
2. `createFolder` — `shared-drive/archive/`
3. `createFolder` — `shared-drive/normalized/`
4. `renamePath` — move stale files to `archive/`
5. `renamePath` — move duplicate files to `duplicates/`
6. `renamePath` — rename inconsistent files to kebab-case and move to `normalized/`
7. `writeFile` — `shared-drive/migration-report.md`

### Expected Final Tree (Partial)
```
workspace-root/
└── shared-drive/
    ├── project-alpha/
    │   ├── spec-v1.md                 (kept)
    │   └── meeting-notes-jan-2025.txt (kept)
    ├── project-beta/
    │   ├── README.md                  (kept)
    │   └── deploy-script.sh           (kept)
    ├── active/
    │   └── (unchanged)
    ├── duplicates/
    │   ├── readme.md                  (from project-beta/)
    │   └── deploy_script.sh           (from project-beta/)
    ├── archive/
    │   ├── report-Q1-2025.pdf         (from project-alpha/)
    │   ├── temp-backup-2024-06.tar    (from misc/)
    │   └── temp_backup_2024_07.tar    (from misc/)
    ├── normalized/
    │   ├── spec-v2.md                 (renamed from spec_v2.md)
    │   └── meeting-notes-feb-2025.txt (renamed from meeting_notes_feb_2025.txt)
    └── migration-report.md
```

### Deterministic Verifier
```javascript
function verifySharedDriveCleanupFixture(workspaceRoot) {
  const fs = require('fs');
  const path = require('path');
  const crypto = require('crypto');
  const assert = (v, msg) => { if (!v) throw new Error(msg); };

  const drivePath = path.join(workspaceRoot, 'shared-drive');
  assert(fs.existsSync(path.join(drivePath, 'duplicates')), 'duplicates folder missing');
  assert(fs.existsSync(path.join(drivePath, 'archive')), 'archive folder missing');
  assert(fs.existsSync(path.join(drivePath, 'normalized')), 'normalized folder missing');
  assert(fs.existsSync(path.join(drivePath, 'migration-report.md')), 'migration report missing');

  const report = fs.readFileSync(path.join(drivePath, 'migration-report.md'), 'utf8');

  // Check seeded deterministic outcomes
  // 1. Duplicate: readme.md should be in duplicates/
  assert(fs.existsSync(path.join(drivePath, 'duplicates', 'readme.md')), 'readme.md should be moved to duplicates');
  assert(fs.existsSync(path.join(drivePath, 'project-beta', 'README.md')), 'README.md should remain in project-beta');

  // 2. Stale: report-Q1-2025.pdf should be in archive/
  assert(fs.existsSync(path.join(drivePath, 'archive', 'report-Q1-2025.pdf')), 'report-Q1-2025.pdf should be archived');

  // 3. Normalized: spec_v2.md renamed to spec-v2.md in normalized/
  assert(fs.existsSync(path.join(drivePath, 'normalized', 'spec-v2.md')), 'spec-v2.md should be in normalized');
  assert(!fs.existsSync(path.join(drivePath, 'project-alpha', 'spec_v2.md')), 'old spec_v2.md should not remain');

  // 4. Active files should remain in place
  assert(fs.existsSync(path.join(drivePath, 'active', 'sprint-23-goals.md')), 'active file should remain');
  assert(fs.existsSync(path.join(drivePath, 'active', 'current-roadmap.md')), 'active file should remain');

  // Report must mention the seeded files
  assert(report.includes('readme.md'), 'report must mention readme.md');
  assert(report.includes('report-Q1-2025.pdf'), 'report must mention report-Q1-2025.pdf');
  assert(report.includes('spec-v2.md') || report.includes('spec_v2.md'), 'report must mention spec v2');

  return { passed: true };
}
```

### Scale Knobs
| Parameter | Default | Range |
|-----------|---------|-------|
| Total files | 500 | 200–2000 |
| Duplicate rate | ~4% | 2%–10% |
| Stale rate | ~6% | 3%–15% |
| Inconsistent naming rate | ~4% | 2%–10% |
| Folder depth | 2 | 1–4 |
| Include content-based duplicate detection | yes | yes/no |
| Include date-parsing from content | yes | yes/no |

### Workload Profile
Matches `refactor` profile with `bulk-inventory` elements (large-scale listing required).

---

## Implementation Sequence

### Phase 1: Legal Intake Routing
1. Write `scripts/generate-fixture-legal-intake.js` — deterministic seed generator
2. Add `legal-intake-small`, `legal-intake-medium`, `legal-intake-large` to `WORKSPACE_FIXTURES`
3. Add branch to `applyWorkspaceFixture()`
4. Write `scripts/verify-fixture-legal-intake.js` — deterministic verifier
5. Run one real ticket against the fixture
6. Capture results; fix only demonstrated defects

### Phase 2: Vendor Compliance Review
1. Write `scripts/generate-fixture-vendor-compliance.js`
2. Add fixture to `WORKSPACE_FIXTURES`
3. Add branch to `applyWorkspaceFixture()`
4. Write `scripts/verify-fixture-vendor-compliance.js`
5. Run real tickets; fix demonstrated defects

### Phase 3: Customer Support Queue
1. Write `scripts/generate-fixture-support-queue.js`
2. Add fixture to `WORKSPACE_FIXTURES`
3. Add branch to `applyWorkspaceFixture()`
4. Write `scripts/verify-fixture-support-queue.js`
5. Run real tickets; fix demonstrated defects

### Phase 4: Shared Drive Cleanup
1. Write `scripts/generate-fixture-shared-drive.js`
2. Add fixture to `WORKSPACE_FIXTURES`
3. Add branch to `applyWorkspaceFixture()`
4. Write `scripts/verify-fixture-shared-drive.js`
5. Run real tickets; fix demonstrated defects

---

## Fixture Design Principles (Enforced)

1. **Every fixture requires file moves or folder creation**, not only `writeFile`
2. **Expected final tree is deterministic** for the seeded data
3. **Verifier checks the tree state**, not only document content
4. **Ticket objectives contain explicit routing rules** so the agent has criteria to apply
5. **Seed data embeds its own classification** (keywords, field presence, dates) so the correct answer is in the data
6. **Scale knobs are numeric parameters** the generator script accepts, not code changes
7. **No synthetic failures are seeded** — the fixture is realistic business data

