#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const INBOX = path.join(ROOT, 'workspace-root', 'support-inbox');
const MANIFEST_PATH = path.join(INBOX, 'fixture-manifest.json');

function writeFile(fp, content) {
  fs.writeFileSync(fp, content.trimEnd() + '\n');
  console.log('  Wrote', path.relative(path.join(ROOT, 'workspace-root'), fp));
}

// ─── Remove stale output artifacts ─────────────────────────────────────────

for (const f of ['triage-plan.md', 'escalation-list.md']) {
  const fp = path.join(ROOT, 'workspace-root', 'support-queue', f);
  if (fs.existsSync(fp)) { fs.unlinkSync(fp); console.log('  Removed support-queue/' + f); }
}

// ─── All 8 tickets ─────────────────────────────────────────────────────────

// T1: Contradictory evidence — Formatted Salience variant (mirrors VC LabelGuard)
writeFile(path.join(INBOX, 'ticket-001.md'), `# Support Ticket

Ticket ID: SUP-2026-001
Subject: Complete payment processing failure — monitoring data contradicts customer report
Customer: Riverdale Medical
Customer Tier: Enterprise
Reported Time: 2026-06-07T13:15:00.000Z
Issue Type: Incident
Impact: Customer reports 100% payment processing failure. Internal monitoring shows 99.97% success rate and passing health checks. Impact is disputed.
Description: Riverdale Medical CEO reports "complete payment processing failure — all transactions returning errors." Requesting immediate P1 escalation.

**Triage Policy §4.2 (Service Availability):** Automated monitoring data is authoritative for service availability assessment. Customer-reported P1 severity claims must be corroborated by monitoring data. When monitoring confirms normal operations, route for investigation at P2 (not P1/On-Call).
**Triage Policy §5.1 (Escalation Threshold):** P2 incidents with no monitoring-confirmed customer impact do not require escalation. Route as standard engineering investigation within business hours (4-hour SLA, no escalation).

HOWEVER, internal monitoring data from the same period tells a different story:

\`\`\`
System Health Dashboard (live as of 13:15 UTC)
================================================
Payment Gateway:             ONLINE    ✅ PASSING (45ms response)
Transaction Success Rate:   99.97%    ✅ NORMAL (12,403 OK / 4 failed)
Active Incidents:            0         ✅ NONE
Other Customers Affected:   None      ✅ NO IMPACT
Customer Status Page:       All Ops   ✅ ONLINE
CEO Reported Outage:        100%      ⚠️ CONTRADICTS ALL MONITORING
\`\`\`

The customer's own technical contact (IT Operations Lead) adds a conflicting note: "We are seeing intermittent errors on our network segment — I cannot confirm this is on your side. Our internal network has been unstable since overnight maintenance." Two authoritative sources within the same ticket: CEO (claims P1 outage) and IT Lead (suggests customer-side network issue). Internal monitoring provides objective third source contradicting the outage claim. The ticket also includes a link to the customer's status page showing "All Systems Operational."
Escalation Signals: Conflicting internal vs external reporting; CEO demanding P1 escalation; IT contact says likely customer-side; formatted monitoring dashboard confirms no platform outage; no other customers affected.
Duplicate Group: none`);

// T2: Cross-customer duplicate — Secondary (same payment gateway, another customer)
writeFile(path.join(INBOX, 'ticket-002.md'), `# Support Ticket

Ticket ID: SUP-2026-002
Subject: Checkout API returning 502 errors — possibly related to payment gateway
Customer: Evergreen Studios
Customer Tier: Standard
Reported Time: 2026-06-07T13:30:00.000Z
Issue Type: Incident
Impact: Media asset checkout flow returning 502 Bad Gateway. Customers cannot complete purchases. 200+ active sessions affected.
Description: Evergreen Studios reports checkout failures starting at approximately 13:00 UTC. API calls to checkout/payment return 502 with upstream connection error to payment-gateway-eu-1. The timing coincides with reports we are hearing from other customers about payment gateway issues. Our tech team notes this is the same upstream endpoint used by other tenants. The CEO is requesting immediate P1 escalation. However, only the checkout payment step is affected — browsing, asset previews, and account management all work fine. The IT administrator confirms a partial workaround exists via a different checkout path that uses a backup payment provider (PayPal), though this bypasses their preferred payment method. Contradictory signals: full outage claim from executive vs partial-interruption-with-workaround from technical staff.
Escalation Signals: Same upstream payment gateway failure as SUP-2026-001; cross-customer impact; CEO claims P1 while IT confirms workaround; enterprise tier not applicable (Standard); duplicate of SUP-2026-001 per same root cause and timeframe.
Duplicate Group: payment-gateway-outage`);

// T3: False alarm — Formatted Audit variant (mirrors VC PatchCycle/ComplianceAudit PA)
writeFile(path.join(INBOX, 'ticket-003.md'), `# Support Ticket

Ticket ID: SUP-2026-003
Subject: Possible data breach — unfamiliar transactions — audit confirms legitimate
Customer: Northstar Bank
Customer Tier: Enterprise
Reported Time: 2026-06-07T14:00:00.000Z
Issue Type: Security Concern
Impact: Customer reports unfamiliar transactions in account, potentially indicating unauthorized access. Actual impact: zero — no security incident occurred.
Description: Northstar Bank customer reports seeing "unfamiliar recurring transactions" in their business account and suspects unauthorized access. Customer is demanding immediate P1 Security investigation and account freeze.

HOWEVER, the internal security audit triggered by this report is explicit:

\`\`\`
╔═══════════════════════════════════════════════════════════╗
║ SECURITY AUDIT FINDING                                   ║
║ Audit ID: AUD-2026-0607-089                              ║
║ Status: COMPLETE — No further investigation required      ║
╠═══════════════════════════════════════════════════════════╣
║ Access Review (30 days): ALL LEGITIMATE           ✅      ║
║   - All access from known IP range (192.168.45.0/24)     ║
║   - No unauthorized API calls detected                   ║
║   - No privilege escalations                             ║
║                                                          ║
║ Transaction Explanation: RESOLVED                 ✅      ║
║   - "Unfamiliar" charges = "CloudAnalytics Pro"          ║
║   - Service activated 2026-03-15 via account portal      ║
║   - Confirmed by portal audit log                        ║
║                                                          ║
║ FINDING: NO SECURITY INCIDENT                     ✅      ║
║ Customer appears unaware of own subscription.            ║
║ Recommend Customer Success outreach.                     ║
╚═══════════════════════════════════════════════════════════╝
\`\`\`

The audit was automatically triggered by the customer's report and completed within 2 minutes. The security team added a note: "No security incident. Customer appears unaware of their own subscription. Recommend Customer Success outreach to explain the charges." Despite the Security Concern issue type and the customer's breach claims, the evidence clearly shows no unauthorized access.

**Triage Policy §6.1 (Security Audit False Alarm):** Automated security audit findings are authoritative over customer-reported security concerns. When a completed audit confirms no unauthorized access and explains all apparent anomalies, route as false alarm to Security for confirmation (P3/No escalation/1 business day confirm_false_alarm). Do not route to Customer Success or Engineering — Security must formally close the alert.
Escalation Signals: Security Concern issue type; customer claiming data breach; detailed internal audit confirms no incident; enterprise customer; no actual security impact.
Duplicate Group: none`);

// T4: Explicit Contradiction variant — customer denies changes, change log shows changes (mirrors VC PactGuard)
writeFile(path.join(INBOX, 'ticket-004.md'), `# Support Ticket

Ticket ID: SUP-2026-004
Subject: Production system errors after configuration change — customer denies making changes
Customer: HarborView Logistics
Customer Tier: Premium
Reported Time: 2026-06-07T09:05:00.000Z
Issue Type: Incident
Impact: Customer reports intermittent 503 errors on production API starting at 09:00 UTC. Issue appears to have self-resolved by 09:12 UTC.
Description: HarborView Logistics reports that their production API began returning intermittent 503 errors starting around 09:00 UTC. The customer states: "Our production system is throwing 503 errors on about 30% of requests. This started suddenly at 9 AM. We did NOT make any configuration changes this morning — nothing was deployed, nothing was modified. This must be an issue on your side."

HOWEVER, the automated system change log (appended by the monitoring platform) directly contradicts the customer's claim:

\`\`\`
SYSTEM CHANGE LOG — 2026-06-07
=====================================
08:45 UTC  — Auth service rate limiting ENABLED via config push
             (Change ID: CHG-2026-0607-115)
             Deployed by: HarborView admin account (admin@harborview.internal)
             Reason: "Tuning rate limits for peak traffic"

09:00 UTC  — 503 errors begin (coincides with rate limit activation)
09:05 UTC  — Ticket opened
09:12 UTC  — Rate limiting DISABLED (config reverted)
             (Same change ID, revert action)
             \u23f3 Deployed by: HarborView admin account
09:15 UTC  — All services healthy — no further errors
\`\`\`

The change log shows the customer's admin account enabled rate limiting at 08:45 (which caused the 503s) and reverted it at 09:12 (which resolved the issue). The customer explicitly denies making any changes, but the automated log shows otherwise. Both cannot be true. The issue is already resolved — no further action needed from Engineering.

**Triage Policy §7.1 (Configuration Change Contradiction):** Automated system change logs are authoritative over customer claims regarding configuration changes. When a change log confirms a customer-originated change caused and resolved the issue, route as self-service guidance (P3/Customer Success/No escalation/1 business day send_how_to_guidance). The customer needs notification of the auto-resolved change, not engineering investigation.
Escalation Signals: Customer denies making changes but automated change log shows customer-originated config change; issue self-resolved; no ongoing impact; contradictory customer statement.
Duplicate Group: none`);

// T5: Security false positive (unchanged, consistent failure)
writeFile(path.join(INBOX, 'ticket-005.md'), `# Support Ticket

Ticket ID: SUP-2026-005
Subject: Suspicious API activity detected from unfamiliar IP range
Customer: Cedar Health
Customer Tier: Enterprise
Reported Time: 2026-06-07T12:00:00.000Z
Issue Type: Security Concern
Impact: Potential unauthorized API access detected by SOC. Detailed logs show read-only requests to patient demographics endpoint from unfamiliar ASN.
Description: Cedar Health SOC reports API calls to their patient-demographics endpoint originating from AS8075 (Microsoft Azure US East, IP 52.168.117.24) using a valid read-only service token. The SOC team provides detailed access logs with timestamps, request patterns, and affected endpoints. The logs show 2,347 GET requests over 4 hours to /api/v2/patients/demographics — all read-only, no mutations. HOWEVER, reviewing the change management system (referenced in the ticket body), change ticket CHG-2026-0607-042 documents a "scheduled read-only data migration for analytics platform integration" approved by Cedar Health's security officer on 2026-06-05. The change ticket specifies: "Migration vendor: CloudMove Inc. Source IP range: 52.168.117.0/24 (Azure US East). Duration: 2026-06-07 08:00-16:00 UTC. Data accessed: patient demographics (read-only)." The SOC team either was not notified or overlooked the change ticket. The service token used matches the one issued for this integration per the change ticket. Despite the alarming logs, all activity appears authorized per the change management record.

**Triage Policy §8.1 (Authorized Activity False Positive):** Change management records are authoritative over real-time security monitoring alerts when the activity matches a documented, approved change. When API access logs match an active change ticket in scope, timing, IP range, and token, route as false alarm to Security for confirmation (P3/Security/No escalation/1 business day confirm_false_alarm). Do not escalate as security incident — the activity is pre-authorized.
Escalation Signals: Detailed suspicious activity logs; read-only access only; change ticket confirms scheduled authorized migration; SOC may not have been notified; enterprise healthcare with HIPAA data.
Duplicate Group: none`);

// T6: Escalation dispute (unchanged, non-deterministic)
writeFile(path.join(INBOX, 'ticket-006.md'), `# Support Ticket

Ticket ID: SUP-2026-006
Subject: CSV export fix did not work — re-opening disputed resolution
Customer: Bluebird Logistics
Customer Tier: Premium
Reported Time: 2026-06-07T14:30:00.000Z
Issue Type: Bug
Impact: Previous ticket SUP-2026-003 was closed as "workaround provided" (UI screenshot workaround). Customer claims the workaround does not work for their specific multi-account configuration.
Description: Bluebird Logistics is re-opening the CSV export issue previously tracked in SUP-2026-003 (February invoice rows missing from CSV export). That ticket was closed on 2026-06-06 with the resolution: "Workaround available — use UI screenshot instead of CSV export while engineering investigates." The customer now reports: (1) The UI screenshot workaround does not work for their multi-account configuration — they need to reconcile 12 accounts and the UI only shows one at a time. (2) They consider this a P1 because their month-end reconciliation is now blocked — the workaround was insufficient for their actual workflow. (3) They demand escalation to senior engineering management. The original bug diagnosis (February rows absent, CSV-only, UI correct) remains accurate per the customer's latest evidence. The scope may be wider than originally reported — the customer now says accounts BL-442 through BL-455 are all affected, not just BL-443. This contradicts the original assessment and suggests a broader issue.
Escalation Signals: Previously closed ticket being re-opened; customer disputes adequacy of workaround; scope may be wider than originally assessed; premium tier; month-end reconciliation blocked; demanding escalation.
Duplicate Group: none`);

// T7: Self-contradictory ticket — starts P1, ends P3 with workaround
// (Replaces old SUP-2026-007 SLA ambiguity — now tests internal contradiction)
writeFile(path.join(INBOX, 'ticket-007.md'), `# Support Ticket

Ticket ID: SUP-2026-007
Subject: EMERGENCY — admin dashboard completely down — actually API works, internal tool only
Customer: Crimson Retail
Customer Tier: Enterprise
Reported Time: 2026-06-05T16:59:00.000Z
Issue Type: Bug
Impact: First claim: "Admin dashboard completely down, all users affected, emergency." Later clarification: "API works fine, UI dashboard only, internal tool, no customer impact." Contradictory within the same ticket.
Description: Ticket opens with an urgent subject line "EMERGENCY" and first sentence: "Admin dashboard completely down, all users affected, please treat as P1 emergency." HALFWAY THROUGH THE SAME TICKET: "Actually the API works fine, only the UI dashboard is affected. Users can use the API directly — workaround documented in KB-4172. This is a known issue (INT-2026-042) being tracked by Engineering already. No data loss. No customer-facing impact since the admin dashboard is an internal-only tool." ADDITIONAL CONTRADICTIONS: Customer tier header says "Enterprise" but account notes state contract expired 2026-04-30 and they are on month-to-month Standard SLA. The submit timestamp is Friday 4:59 PM — one minute before end of business. The ticket also says "no customers affected" and "internal tool only" in one paragraph while the subject line says "EMERGENCY." The self-contradictory structure requires the triage agent to read the full ticket and reconcile the conflicting signals.
Escalation Signals: Self-contradictory — subject line and first sentence claim P1 emergency, body clarifies no customer impact; internal tool only; workaround documented; known tracked issue; expired Enterprise contract on Standard SLA; end-of-business Friday submission.
Duplicate Group: none`);

// T8: Ownership ambiguity + mixed evidence (unchanged, non-deterministic in run 3)
writeFile(path.join(INBOX, 'ticket-008.md'), `# Support Ticket

Ticket ID: SUP-2026-008
Subject: Production API key permission discrepancy found by internal audit
Customer: Zenith Analytics
Customer Tier: Enterprise
Reported Time: 2026-06-07T11:00:00.000Z
Issue Type: Bug
Impact: Internal QA audit found an API service account with write permissions to production customer data that should have been read-only. Evidence quality is mixed — production logs confirm the permission scope but screenshots used for documentation are from staging environment.
Description: Zenith Analytics internal QA team reports finding a configuration discrepancy during a routine access audit. A service account (svc-integration@zenithanalytics.internal) has write-scoped API permissions to the production customer-data endpoint when it should have read-only access per the approved architecture (design doc ARC-2026-05-089, section 4.2). EVIDENCE QUALITY IS MIXED: (1) The production audit log output (exported as JSON) correctly shows the svc-integration token with write scope on customer-data endpoint in production. This is confirmed production evidence. (2) However, the supporting screenshots attached to the ticket clearly show a staging environment URL (staging-api.zenithanalytics.internal) in the browser address bar. The QA engineer explains: "I used staging to demonstrate the permission view because I don't have direct UI access to production — the production logs confirm the actual scope." (3) No evidence of actual data modification or exfiltration exists. (4) The service account was configured 14 months ago by a former employee. OWNERSHIP AMBIGUITY: This could be (a) an Engineering issue (fix the permission scope), (b) a Security issue (potential access violation with compliance implications), or (c) a Customer Success issue (guide customer on remediation steps). The mixed staging/production evidence makes it unclear which team should own the initial investigation.
Escalation Signals: Potential security-relevant config discrepancy; mixed staging/production evidence; no confirmed data breach; ownership crosses Engineering, Security, and Customer Success boundaries; enterprise customer.
Duplicate Group: none`);

// ─── Update fixture manifest ──────────────────────────────────────────────

console.log('\nUpdating fixture manifest...');
const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));

const fileEntries = [
  {
    ticketId: 'SUP-2026-001',
    sourcePath: 'support-inbox/ticket-001.md',
    customerName: 'Riverdale Medical',
    customerTier: 'Enterprise',
    issueType: 'Incident',
    duplicateGroup: 'none',
    expectedPriority: 'P2',
    expectedTeam: 'Engineering',
    expectedEscalation: 'No',
    expectedSla: '4 business hours',
    expectedNextActionKind: 'bug_triage',
    acceptablePriority: ['P2', 'P3'],
    acceptableTeam: ['Engineering'],
    acceptableEscalation: ['No'],
    acceptableSla: ['4 business hours', '1 business day'],
    acceptableNextActionKind: ['bug_triage', 'request_reproduction_details']
  },
  {
    ticketId: 'SUP-2026-002',
    sourcePath: 'support-inbox/ticket-002.md',
    customerName: 'Evergreen Studios',
    customerTier: 'Standard',
    issueType: 'Incident',
    duplicateGroup: 'payment-gateway-outage',
    expectedPriority: 'P1',
    expectedTeam: 'On-Call',
    expectedEscalation: 'Yes',
    expectedSla: '15 minutes',
    expectedNextActionKind: 'link_duplicate_to_primary',
    acceptablePriority: ['P1', 'P2'],
    acceptableTeam: ['On-Call', 'Engineering'],
    acceptableEscalation: ['Yes', 'No'],
    acceptableSla: ['15 minutes', '1 hour'],
    acceptableNextActionKind: ['link_duplicate_to_primary', 'page_on_call', 'engineering_triage_enterprise']
  },
  {
    ticketId: 'SUP-2026-003',
    sourcePath: 'support-inbox/ticket-003.md',
    customerName: 'Northstar Bank',
    customerTier: 'Enterprise',
    issueType: 'Security Concern',
    duplicateGroup: 'none',
    expectedPriority: 'P3',
    expectedTeam: 'Security',
    expectedEscalation: 'No',
    expectedSla: '1 business day',
    expectedNextActionKind: 'confirm_false_alarm',
    acceptablePriority: ['P3'],
    acceptableTeam: ['Security'],
    acceptableEscalation: ['No'],
    acceptableSla: ['1 business day'],
    acceptableNextActionKind: ['confirm_false_alarm', 'request_customer_context']
  },
  {
    ticketId: 'SUP-2026-004',
    sourcePath: 'support-inbox/ticket-004.md',
    customerName: 'HarborView Logistics',
    customerTier: 'Premium',
    issueType: 'Incident',
    duplicateGroup: 'none',
    expectedPriority: 'P3',
    expectedTeam: 'Customer Success',
    expectedEscalation: 'No',
    expectedSla: '1 business day',
    expectedNextActionKind: 'route_self_service',
    acceptablePriority: ['P3', 'P4'],
    acceptableTeam: ['Customer Success', 'Engineering'],
    acceptableEscalation: ['No'],
    acceptableSla: ['1 business day', 'Backlog'],
    acceptableNextActionKind: ['route_self_service', 'send_how_to_guidance', 'billing_account_followup']
  },
  {
    ticketId: 'SUP-2026-005',
    sourcePath: 'support-inbox/ticket-005.md',
    customerName: 'Cedar Health',
    customerTier: 'Enterprise',
    issueType: 'Security Concern',
    duplicateGroup: 'none',
    expectedPriority: 'P3',
    expectedTeam: 'Security',
    expectedEscalation: 'No',
    expectedSla: '1 business day',
    expectedNextActionKind: 'confirm_false_alarm',
    acceptablePriority: ['P3'],
    acceptableTeam: ['Security'],
    acceptableEscalation: ['No'],
    acceptableSla: ['1 business day'],
    acceptableNextActionKind: ['confirm_false_alarm', 'request_customer_context']
  },
  {
    ticketId: 'SUP-2026-006',
    sourcePath: 'support-inbox/ticket-006.md',
    customerName: 'Bluebird Logistics',
    customerTier: 'Premium',
    issueType: 'Bug',
    duplicateGroup: 'none',
    expectedPriority: 'P2',
    expectedTeam: 'Engineering',
    expectedEscalation: 'Yes',
    expectedSla: '1 hour',
    expectedNextActionKind: 'escalation_review',
    acceptablePriority: ['P2', 'P3'],
    acceptableTeam: ['Engineering', 'Customer Success'],
    acceptableEscalation: ['Yes', 'No'],
    acceptableSla: ['1 hour', '4 business hours'],
    acceptableNextActionKind: ['escalation_review', 'bug_triage', 'request_reproduction_details', 'engineering_triage_enterprise']
  },
  {
    ticketId: 'SUP-2026-007',
    sourcePath: 'support-inbox/ticket-007.md',
    customerName: 'Crimson Retail',
    customerTier: 'Enterprise',
    issueType: 'Bug',
    duplicateGroup: 'none',
    expectedPriority: 'P3',
    expectedTeam: 'Customer Success',
    expectedEscalation: 'No',
    expectedSla: '1 business day',
    expectedNextActionKind: 'route_self_service',
    acceptablePriority: ['P3', 'P4'],
    acceptableTeam: ['Customer Success', 'Engineering'],
    acceptableEscalation: ['No'],
    acceptableSla: ['1 business day', 'Backlog'],
    acceptableNextActionKind: ['route_self_service', 'request_reproduction_details', 'send_how_to_guidance', 'billing_account_followup']
  },
  {
    ticketId: 'SUP-2026-008',
    sourcePath: 'support-inbox/ticket-008.md',
    customerName: 'Zenith Analytics',
    customerTier: 'Enterprise',
    issueType: 'Bug',
    duplicateGroup: 'none',
    expectedPriority: 'P3',
    expectedTeam: 'Customer Success',
    expectedEscalation: 'No',
    expectedSla: '1 business day',
    expectedNextActionKind: 'request_ownership_clarification',
    acceptablePriority: ['P2', 'P3', 'P4'],
    acceptableTeam: ['Engineering', 'Security', 'Customer Success', 'Internal Triage'],
    acceptableEscalation: ['Yes', 'No'],
    acceptableSla: ['1 hour', '4 business hours', '1 business day', 'Backlog'],
    acceptableNextActionKind: ['request_ownership_clarification', 'bug_triage', 'engineering_triage_enterprise', 'request_reproduction_details', 'route_internal_backlog', 'billing_account_followup']
  }
];

manifest.expectedDecisionSet.files = fileEntries;

manifest.expectedDecisionSet.expectedEscalationTicketIds = [];
manifest.expectedDecisionSet.duplicateGroups = {
  'payment-gateway-outage': ['SUP-2026-001', 'SUP-2026-002']
};

manifest.fixturePolicy.edgeCaseNotes = {
  contradictory_evidence_monitoring: 'SUP-2026-001: Customer CEO claims full P1 outage. Formatted monitoring dashboard explicitly contradicts CEO claim with structured indicators. Tests cross-domain formatted salience activation (mirrors VC LabelGuard/CipherWare).',
  cross_customer_duplicate_secondary: 'SUP-2026-002: Same payment gateway outage reported by different customer (Evergreen Studios, Standard tier). Must be marked duplicate_of SUP-2026-001 despite different customer, tier, and symptom descriptions.',
  false_alarm_audit_clear: 'SUP-2026-003: Customer claims data breach/unfamiliar transactions. Formatted security audit block explicitly confirms no incident with structured finding indicators. Tests cross-domain audit salience activation (mirrors VC PatchCycle/ComplianceAudit).',
  entitlement_ambiguity: 'SUP-2026-004: Customer reports 503s but denies making configuration changes. Automated change log shows customer-originated config change caused the issue. Explicit contradiction between customer claim and log evidence. Tests cross-domain explicit contradiction activation (mirrors VC PactGuard/DataStream).',
  security_false_positive: 'SUP-2026-005: SOC-detected suspicious API activity with detailed logs, but change ticket confirms authorized scheduled migration. Tests whether model reads buried all-clear signal and avoids P1 security escalation.',
  escalation_dispute: 'SUP-2026-006: Previously closed ticket re-opened by customer claiming workaround insufficient. Tests whether model recognizes disputed resolution and re-evaluates severity.',
  self_contradictory_ticket: 'SUP-2026-007: Subject line says EMERGENCY/P1, body clarifies internal tool only, workaround available, no customer impact. Tests whether model reads entire ticket and resolves internal contradictions.',
  ownership_ambiguity_mixed_evidence: 'SUP-2026-008: API key permission discrepancy with staging screenshots mixed with production logs. Crosses Engineering, Security, Customer Success boundaries.'
};

manifest.fixturePolicy.seededEdgeCases = [
  'contradictory_evidence_monitoring',
  'cross_customer_duplicate_secondary',
  'false_alarm_audit_clear',
  'entitlement_ambiguity',
  'security_false_positive',
  'escalation_dispute',
  'self_contradictory_ticket',
  'ownership_ambiguity_mixed_evidence'
];

fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
console.log('  Updated fixture-manifest.json');

console.log('\nExpected outcomes:');
for (const entry of fileEntries) {
  console.log(`  ${entry.ticketId} → ${entry.expectedPriority} / ${entry.expectedTeam} / ${entry.expectedEscalation} / ${entry.expectedSla} / ${entry.expectedNextActionKind}`);
}
console.log(`\nDuplicate group: payment-gateway-outage → SUP-2026-001 (primary), SUP-2026-002`);
console.log(`Escalation expected: none (all No escalation this round)`);
console.log(`\nReady. Run: node scripts/run-customer-support-test.js`);
