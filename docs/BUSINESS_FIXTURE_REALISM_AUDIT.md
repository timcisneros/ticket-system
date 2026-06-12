# Business Fixture Realism Audit

## Audit Method

For each fixture, evaluate against:

1. **Real business owner** — who pays for this
2. **Real trigger event** — what causes the work to start
3. **Real inputs** — what actually arrives
4. **Real outputs** — what the business actually needs
5. **Real success metric** — how the business knows it worked
6. **Human would do this today** — whether the work exists in the real world

Then identify:
- **Artificial rules** — logic that exists only for testing
- **Unrealistic routing criteria** — criteria no business would actually use
- **Verifier assumptions** — checks that assume test-shaped behavior, not business behavior

---

## Fixture 1: Legal Intake Routing

### Realism Assessment

**Real business owner:** Legal operations manager, in-house counsel, or paralegal at a company with enough legal volume to need intake tracking.

**Real trigger event:** A business unit submits a legal request (contract review, NDA, dispute, compliance question).

**Real inputs:**
- In the real world: an email to legal@company.com, a Slack message, a Salesforce case, or a form in a legal hold system.
- **Not** individual markdown files in a filesystem folder.

**Real outputs:**
- A matter opened in a case management system (Clio, TeamConnect, Salesforce Legal, or a shared spreadsheet).
- An assignment to a lawyer or paralegal.
- A tracking number or case ID.
- A response email to the requester.
- **Not** a set of filesystem folders with moved markdown files.

**Real success metric:**
- All matters are tracked.
- No request falls through cracks.
- SLAs are met (e.g., "contract review within 5 business days").
- Legal spend is documented.
- **Not** "all files were moved to the correct folder."

**Human would do this today?**
**Partially yes, but the form is wrong.**

A human absolutely triages legal intake. But they do it in a **system**, not in a filesystem. The human would:
- Read the intake form (or email).
- Enter it into a case management system.
- Assign it to the right person.
- Email the requester if information is missing.
- Set a status: "open", "awaiting info", "in review", "completed", "referred to outside counsel".
- **Never** move markdown files between folders as the primary workflow.

### Artificial Rules

| Artificial Rule | Why It Is Artificial |
|-----------------|----------------------|
| Route by moving markdown files between folders | No legal team uses filesystem folders as their intake router. They use case management systems or spreadsheets. |
| Three rigid categories: accepted / rejected / needs-followup | Real legal intake has more nuanced states: "opened", "awaiting info from requester", "assigned to outside counsel", "on hold", "completed", "declined". "Rejected" is almost never used — the team emails back for missing info. |
| Rejected if Requesting Party or Matter Type is missing | In reality, missing fields trigger an email back to the requester. The matter is not "rejected"; it is "awaiting info." |
| Moving files equals workflow state | The verifier assumes folder placement is the state. In reality, state lives in a database or spreadsheet. |

### Unrealistic Routing Criteria

| Criteria | Realism Problem |
|----------|-----------------|
| Missing Jurisdiction = needs-followup | A missing jurisdiction is often handled by assuming the company's home jurisdiction, not by pausing the matter. |
| Missing Description = needs-followup | A missing description is resolved by calling the requester. The file does not sit in a "needs-followup" folder. |
| All fields must be present to proceed | Real intake forms are incomplete all the time. The legal team opens the matter and gathers info as they go. |

### Verifier Assumptions That Only Exist for Testing

1. **Deterministic folder placement** — the verifier expects exact files in exact folders. Real legal intake would not be deterministic even with the same inputs (different people triage differently).
2. **Field presence is the only routing signal** — the verifier ignores the *content* of the fields. A real legal ops person would also consider urgency, matter type, and business impact.
3. **Summary must reference every file by name** — the verifier checks string matching. A real summary would reference matter numbers, not filenames.

### Verdict

**Weak realism.** The classification task is real, but the file-move routing mechanism is entirely test-shaped. A real business would not pay for "move markdown files between folders." They would pay for "track and assign legal matters correctly."

---

## Fixture 2: Vendor Compliance Review

### Realism Assessment

**Real business owner:** Procurement compliance officer, vendor risk manager, or third-party risk analyst.

**Real trigger event:**
- Quarterly vendor review cycle.
- New vendor onboarding.
- Audit preparation (SOC 2, ISO 27001, GDPR).
- Security incident involving a vendor.

**Real inputs:**
- Vendor questionnaires (SIG, VSA, or custom).
- Security certifications (SOC 2 reports, ISO 27001 certificates).
- DPAs and BAAs.
- References and background checks.
- **Not** a folder of markdown files representing a "vendor packet."

**Real outputs:**
- Vendor risk score or rating.
- Approval/rejection in a vendor management system (VMS).
- Audit evidence package.
- Remediation plan for vendors that need work.
- **Not** a filesystem tree with moved folders.

**Real success metric:**
- Approved vendors meet security and compliance standards.
- Rejected vendors are blocked from procurement.
- Audit passes with no findings.
- No supply-chain breach from an unvetted vendor.
- **Not** "all vendor folders were moved to the correct bucket."

**Human would do this today?**
**Yes — this is very realistic work.**

Large companies have entire teams (third-party risk management, TPRM) that do this. They:
- Review vendor security questionnaires.
- Check certification validity.
- Look up incident records.
- Compare against policy requirements.
- Make approve / reject / conditional-approve decisions.
- Document findings.

However, they do it in **vendor management systems** (BitSight, SecurityScorecard, ProcessUnity, RSA Archer) or at minimum in spreadsheets with workflow states. They do **not** move vendor folders around in a shared drive.

### Artificial Rules

| Artificial Rule | Why It Is Artificial |
|-----------------|----------------------|
| Move vendor folders to approved/rejected/needs-review folders | No vendor compliance team uses filesystem folders as their approval mechanism. The decision is recorded in a VMS or spreadsheet. |
| 5-vendor sample | A real quarterly review covers dozens to hundreds of vendors. 5 is a toy sample. |
| Vendor "packet" as a folder of markdown files | Real vendor packets are PDFs (SOC 2 reports), Word docs (DPAs), and scanned certificates. |

### Unrealistic Routing Criteria

| Criteria | Realism Problem |
|----------|-----------------|
| Rejected if certification expired | Realistic — but in reality, the vendor is given a window to renew, not immediately rejected. |
| Rejected if incident exists | Realistic — but severity matters. A minor incident might trigger "needs-review" with remediation plan, not rejection. |
| ISO 27001 is "non-standard" | ISO 27001 is a standard certification. Flagging it as non-standard is arbitrary and unrealistic. |

### Verifier Assumptions That Only Exist for Testing

1. **Folder placement equals compliance decision** — the verifier checks that vendor-beta is in "rejected" because it is missing a cert. In reality, the decision is recorded in a system, not a folder tree.
2. **Deterministic routing from seeded data** — the verifier knows the "correct" answer because it seeded the data. A real compliance review has judgment and edge cases.
3. **Audit findings must reference every vendor** — a real audit findings report might focus on exceptions and gaps, not list every approved vendor.

### Verdict

**Strong realism for the work, weak realism for the mechanism.**

The *work* is real and valuable. The *file-move mechanism* is test-shaped. A real business would pay for vendor compliance review, but not delivered as "move folders around." The correct abstraction is closer to: "read vendor evidence, compare against policy, write a compliance decision record."

---

## Fixture 3: Customer Support Queue

### Realism Assessment

**Real business owner:** Support team lead, customer success manager, or VP of Customer Support.

**Real trigger event:**
- Tickets arrive via Zendesk, Intercom, Jira Service Desk, or email.
- SLA breach imminent.
- On-call handoff.

**Real inputs:**
- Support tickets with subject, description, customer ID, severity flags, and metadata.
- **Not** plain text files in a filesystem folder.

**Real outputs:**
- Tickets prioritized and assigned in a ticketing system.
- P1 incidents escalated to engineering on-call.
- Agent workload balanced.
- Response sent to customer.
- **Not** text files moved into P1/P2/P3 folders.

**Real success metric:**
- First-response time SLA met.
- Resolution time SLA met.
- Customer satisfaction (CSAT) maintained.
- No P1 incident missed.
- **Not** "all tickets were moved to the correct priority folder."

**Human would do this today?**
**Yes — this is one of the most realistic workflows.**

Support triage is a daily activity at every SaaS company. The human would:
- Read incoming tickets.
- Classify priority based on impact, urgency, and customer tier.
- Assign to the right agent or team.
- Escalate P1s immediately (Slack, pager, phone).
- **Not** move files into folders.

### Artificial Rules

| Artificial Rule | Why It Is Artificial |
|-----------------|----------------------|
| Move ticket files to P1/P2/P3 folders | No support team uses filesystem folders as their queue. They use Zendesk, Jira, or Intercom queues. |
| "Create folders" as a triage step | Folders are irrelevant to support workflow. The queue lives in a system. |
| Write assignments.md as the primary output | The real output is ticket assignment in the system, plus maybe a Slack message or handoff note. |

### Unrealistic Routing Criteria

| Criteria | Realism Problem |
|----------|-----------------|
| Keyword-based classification ("all users" = P1) | Real support triage considers customer tier, revenue impact, and historical context, not just keywords. A "how do I" question from a $1M ARR customer might be P2, not P3. |
| Exactly 3 priority levels | Most support teams use 4–5 levels (P0 = all-hands emergency, P1 = major outage, P2 = significant impact, P3 = minor, P4 = question/feature request). |
| No customer context | Real tickets include customer ID, plan tier, and account history. A support lead uses all of this. |

### Verifier Assumptions That Only Exist for Testing

1. **Keyword-matching equals correct classification** — the verifier checks that "all users" or "data loss" keywords triggered P1. Real triage is more nuanced.
2. **Exact folder placement** — the verifier expects deterministic placement. Two humans might classify the same ticket differently based on customer context.
3. **Assignments.md references every file** — a real handoff note might say "3 P1s escalated, 4 P2s assigned to Sarah, rest in queue."

### Verdict

**Moderate realism.** The classification task is extremely real, but the filesystem-folder mechanism is test-shaped. A real business would absolutely pay for support triage, but delivered as "read tickets and assign/escalate correctly in our system." The output should be a set of assignments or escalations, not a folder tree.

---

## Fixture 4: Shared Drive Cleanup

### Realism Assessment

**Real business owner:** IT administrator, records manager, or knowledge management lead.

**Real trigger event:**
- Storage quota approaching limit.
- Annual records retention review.
- Compliance audit requiring evidence of data governance.
- Migration to a new document management system (SharePoint, Google Drive, Confluence).

**Real inputs:**
- A shared drive (SMB, Google Drive, SharePoint, S3 bucket) with years of accumulated files.
- Mixed formats: PDFs, Word docs, spreadsheets, images, ZIPs.
- No consistent naming.
- Duplicates from copy-paste and email attachments.
- **This is the most realistic input of all four fixtures.**

**Real outputs:**
- Cleaned drive with archived stale files.
- Deduplicated storage.
- Normalized naming (if policy requires it).
- Migration report for auditors.
- **Moving files to archive/ and duplicates/ folders is actually realistic.**

**Real success metric:**
- Storage reduced by X%.
- Stale files moved to cold storage.
- Duplicates removed.
- Users can find active documents.
- Audit passes.
- **"Files were correctly categorized" is a real success metric here.**

**Human would do this today?**
**Yes — but not manually for 500 files.**

A human would:
- Use a deduplication tool (dupeGuru, rdfind, or built-in SharePoint/Google Drive features).
- Use scripts to find stale files by last-modified date.
- Run bulk renames with regex.
- Review a sample of flagged files before bulk actions.
- **Not** read every file individually and decide one by one.

For 50 files, manual cleanup is realistic. For 500+, it is script territory.

### Artificial Rules

| Artificial Rule | Why It Is Artificial |
|-----------------|----------------------|
| Agent must inspect 500+ files individually | No human does this. They use scripts and tools. An agent that lists and reads 500 files one by one would hit runtime limits and be impractical. |
| "First-seen variant" is the original | Determining which duplicate is the "original" is arbitrary. Real tools use "keep newest" or "keep in canonical location." |
| Kebab-case normalization as a policy | Some companies have naming policies, but they are usually enforced at creation time, not retroactively. |
| Date extraction from filename | Real stale detection uses file system metadata (mtime), not filename parsing. |

### Unrealistic Routing Criteria

| Criteria | Realism Problem |
|----------|-----------------|
| Filename contains "2024" = stale | A file named "budget-2024-vs-2025.xlsx" is current work, not stale. Real stale detection uses last-modified date. |
| Content mentions old date = stale | A Q1 2025 report that references 2024 data is current, not stale. |
| Content-based duplicate detection | Realistic in principle, but comparing 500 files by content requires hashing, not reading every file. |

### Verifier Assumptions That Only Exist for Testing

1. **Deterministic "original" vs "duplicate"** — the verifier assumes a specific file is the original. In reality, any of the duplicates could be kept.
2. **Filename-based stale detection** — the verifier checks for filenames with "2024". Real stale detection checks `fs.stat.mtime`.
3. **Kebab-case as the one true format** — the verifier enforces a specific normalization. Real policies vary.

### Verdict

**Mixed realism.** The *problem* is very real — shared drive cleanup is a genuine IT task. The *scale* (500+ files) is realistic. But the *mechanism* (agent reads every file individually to classify it) is artificial. A real business would script the bulk detection and have a human review samples. The agent's role would be more like "review flagged items and approve bulk actions" or "write the migration report after scripts do the heavy lifting."

---

## Cross-Fixture Analysis

### Common Pattern: "Move Files = Route Work"

**All four fixtures use filesystem moves as the routing mechanism.** This is the single biggest artificial element. In the real world:
- **Legal intake** → case management system status field
- **Vendor compliance** → VMS approval flag
- **Support triage** → ticketing system priority and assignment
- **Drive cleanup** → this one is partially realistic (moving files to archive is a real cleanup action)

### Common Pattern: "Verifier Knows the Answer"

All verifiers assume deterministic, seeded outcomes. In the real world:
- Two humans might classify the same support ticket differently.
- A legal ops manager might accept an incomplete intake if the matter is urgent.
- A compliance officer might give a vendor a grace period for an expired cert.
- An IT admin might keep a "stale" file because it is referenced by an active project.

### Common Pattern: "No System Context"

None of the fixtures include:
- Customer tier / account value (support).
- Matter urgency or business impact (legal).
- Vendor criticality or spend (compliance).
- File references from active projects (cleanup).

Real routing decisions depend on context that the fixtures do not provide.

---

## Recommended Redesign Principles

If the goal is "business-shaped logic, not fixture-shaped logic," the fixtures should be redesigned around these principles:

1. **State changes are the output, not folder moves.**
   - Legal: produce a routing log or case tracker document, not moved files.
   - Vendor: produce a compliance decision log, not moved folders.
   - Support: produce an assignment plan, not moved files.
   - Cleanup: this is the one where file moves are actually realistic, but scale must be reduced or bulk-detection scripted.

2. **Provide business context in the inputs.**
   - Support tickets should include customer tier.
   - Legal intake should include urgency and business unit.
   - Vendor packets should include spend tier and criticality.
   - Drive cleanup should include active project references.

3. **Success criteria should match business outcomes.**
   - Legal: "all matters tracked and assigned" not "all files in correct folder."
   - Vendor: "all vendors evaluated against policy" not "all folders moved."
   - Support: "P1s escalated, P2s assigned, queue documented" not "files sorted."
   - Cleanup: "stale files archived, duplicates flagged" — but detection should be metadata-driven, not filename-driven.

4. **Verifiers should allow judgment, not enforce deterministic placement.**
   - A support ticket about a memory leak could be P1 (affecting production) or P2 (affecting one feature). The verifier should check that *some* classification was applied and P1s were escalated, not that ticket-009 is exactly in P2.
   - A vendor with an expired cert might be "needs-review" (if renewing) or "rejected" (if expired > 6 months). The verifier should check the reasoning is sound, not the folder placement.

5. **Scale must match human capacity.**
   - 10 items → human can review individually.
   - 50 items → human reviews samples, scripts handle bulk.
   - 500+ items → human reviews exceptions only, scripts do detection.
   - Fixtures should not ask the agent to do work that a human would script.

---

## Individual Verdicts

| Fixture | Realism | Would a Business Pay? | Primary Weakness |
|---------|---------|----------------------|------------------|
| Legal Intake | Weak | No — not as a file-move workflow | File-move routing is not a real legal process |
| Vendor Compliance | Strong work, weak mechanism | Yes for the work, no for the mechanism | File-move approval is not how TPRM works |
| Customer Support | Moderate | Yes for triage, no for file moves | File-move queue is not a real support process |
| Shared Drive Cleanup | Mixed | Yes — but at smaller scale or with scripted detection | 500-file manual inspection is unrealistic |

---

## Conclusion

The fixtures are **realism-inverted**: the *simplest* fixture (support queue) describes the most real daily work, while the *most complex* fixture (vendor compliance) has the most realistic business logic but the most artificial mechanism.

The fundamental flaw across all fixtures is the **equation of "file move" with "business decision."** In reality, business decisions are recorded in systems, spreadsheets, or documents. Only the cleanup fixture has a genuine reason to move files — and even then, the scale and detection method must be redesigned to match how humans actually do this work.

