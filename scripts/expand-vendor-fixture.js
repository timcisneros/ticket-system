#!/usr/bin/env node
/**
 * Expand Vendor Compliance fixture with 8 new realistic edge cases.
 * Replaces 8 simple probabilistic vendors with complex business scenarios.
 * Does not modify workflows, verifiers, or runtime.
 */

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const VENDORS = path.join(ROOT, 'workspace-root', 'vendors', 'incoming');
const MANIFEST_PATH = path.join(ROOT, 'workspace-root', 'vendors', 'fixture-manifest.json');

function writeFile(fp, content) {
  fs.writeFileSync(fp, content.trimEnd() + '\n');
  console.log('  Wrote', path.relative(path.join(ROOT, 'workspace-root'), fp));
}

// ─── New Vendor Definitions ─────────────────────────────────

const replacements = {
  // vendor-007: Multi-tier subcontractor
  'vendor-007': {
    vendorId: 'vendor-007',
    vendorName: 'DataBridge Logistics',
    service: 'Supply chain data processing and subcontracted logistics analytics via CloudSync Solutions (third-party)',
    criticality: 'High',
    annualSpend: '$680K',
    dpaStatus: 'Signed and current (covers DataBridge only)',
    dataAccess: 'Customer order data, inventory levels, and shipping manifests',
    certification: 'SOC 2 Type II',
    certificationExpiry: '2027-03-15',
    certificationStatus: 'Current',
    incidentStatus: 'None reported',
    note: '## Subcontractor Note\nDataBridge Logistics subcontracts all data processing to CloudSync Solutions (a third-party vendor). CloudSync Solutions has no DPA on file with us and their SOC 2 certification expired 2026-01-30. DataBridge\'s own DPA and certification are current but do not explicitly cover subcontracted processing. The policy does not address sub-tier vendor compliance. Expected: Conditional Approve — primary vendor is compliant but subcontractor chain is unverified.',
    expectedDisposition: 'Conditional Approve',
    acceptableDispositions: ['Conditional Approve'],
    reasonCode: 'subcontractor_unverified',
    expectedNextActionKind: 'subcontractor_dpa_verify'
  },

  // vendor-008: Cross-border data transfer
  'vendor-008': {
    vendorId: 'vendor-008',
    vendorName: 'EuroHost Solutions',
    service: 'Cloud hosting and data processing services from data centers in Frankfurt, Germany',
    criticality: 'High',
    annualSpend: '$520K',
    dpaStatus: 'Signed and current',
    dataAccess: 'Customer account data, transaction records, and support ticket contents',
    certification: 'ISO 27001',
    certificationExpiry: '2027-08-22',
    certificationStatus: 'Current',
    incidentStatus: 'None reported',
    note: '## Data Residency Note\nEuroHost operates exclusively from EU data centers (Frankfurt, Germany). Our policy requires data residency within approved regions. The DPA includes standard clauses but does not include an explicit data residency clause specifying where customer data is stored. While all certifications are current and the DPA is signed, the lack of explicit data residency language creates ambiguity for compliance review. Expected: Conditional Approve — technical compliance is strong but data residency not explicitly contracted.',
    expectedDisposition: 'Conditional Approve',
    acceptableDispositions: ['Conditional Approve'],
    reasonCode: 'data_residency_not_explicit',
    expectedNextActionKind: 'data_residency_clarify'
  },

  // vendor-014: Regulatory exception — GDPR/HIPAA overlap
  'vendor-014': {
    vendorId: 'vendor-014',
    vendorName: 'HealthData Sync',
    service: 'Cross-border healthcare data analytics for EU and US patient populations',
    criticality: 'Critical',
    annualSpend: '$1.2M',
    dpaStatus: 'Signed and current',
    dataAccess: 'PHI (protected health information) for US patients and EU healthcare data subject to GDPR',
    certification: 'SOC 2 Type II',
    certificationExpiry: '2027-06-30',
    certificationStatus: 'Current',
    incidentStatus: 'None reported',
    note: '## Regulatory Exception Note\nHealthData Sync processes both US healthcare data (HIPAA-covered) and EU healthcare data (GDPR-covered). They hold SOC 2 Type II certification (US standard) but do not hold an equivalent EU-specific certification or GDPR adequacy decision. The DPA is signed and covers both jurisdictions but the security certification covers only US standards. The policy does not distinguish between regulatory frameworks. Expected: Conditional Approve — meets US requirements, EU GDPR adequacy unverified.',
    expectedDisposition: 'Conditional Approve',
    acceptableDispositions: ['Conditional Approve'],
    reasonCode: 'cross_regulatory_incomplete',
    expectedNextActionKind: 'gdpr_adequacy_assessment'
  },

  // vendor-017: Rebranding with legal continuity gap
  'vendor-017': {
    vendorId: 'vendor-017',
    vendorName: 'NexGen Analytics (formerly DataStream Analytics)',
    service: 'Business intelligence and data analytics platform for enterprise customers',
    criticality: 'High',
    annualSpend: '$450K',
    dpaStatus: 'Signed and current (under former legal name: DataStream Analytics Inc.)',
    dataAccess: 'Customer business metrics, sales data, and operational KPIs',
    certification: 'ISO 27001',
    certificationExpiry: '2026-12-15',
    certificationStatus: 'Current',
    incidentStatus: 'None reported',
    note: '## Entity Name Change Note\nNexGen Analytics rebranded from DataStream Analytics in January 2026. All legal contracts, the DPA, and the ISO 27001 certification remain under the former legal name "DataStream Analytics Inc." The vendor operates under "NexGen Analytics" but no legal name change filing has been confirmed. The certification body has not been notified of the name change. Expected: Conditional Approve — evidence exists but under inconsistent legal identity.',
    expectedDisposition: 'Conditional Approve',
    acceptableDispositions: ['Conditional Approve'],
    reasonCode: 'entity_name_inconsistency',
    expectedNextActionKind: 'entity_verification'
  },

  // vendor-018: Recently acquired by competitor
  'vendor-018': {
    vendorId: 'vendor-018',
    vendorName: 'SecureVault Systems',
    service: 'Encrypted data storage and key management for enterprise security teams',
    criticality: 'Critical',
    annualSpend: '$890K',
    dpaStatus: 'Signed and current',
    dataAccess: 'Customer encryption keys and security configuration data',
    certification: 'SOC 2 Type II',
    certificationExpiry: '2027-04-30',
    certificationStatus: 'Current',
    incidentStatus: 'None reported',
    note: '## Acquisition by Competitor Note\nSecureVault Systems was acquired by CompeteCorp (a direct competitor to our infrastructure provider CloudHost Inc) on 2026-05-01. All certifications remain current, the DPA remains signed, and operations are unchanged. However, the ownership change places our critical encryption infrastructure under a competitor\'s control — a conflict of interest not addressed by standard compliance policy. Expected: Conditional Approve — technical compliance intact, ownership risk unaddressed.',
    expectedDisposition: 'Conditional Approve',
    acceptableDispositions: ['Conditional Approve', 'Reject'],
    reasonCode: 'competitor_acquisition_risk',
    expectedNextActionKind: 'ownership_review'
  },

  // vendor-019: Rolling audit with minor deficiencies
  'vendor-019': {
    vendorId: 'vendor-019',
    vendorName: 'ComplianceCheck Pro',
    service: 'Automated compliance monitoring and audit trail generation',
    criticality: 'High',
    annualSpend: '$310K',
    dpaStatus: 'Signed and current',
    dataAccess: 'Customer compliance configurations and audit log metadata',
    certification: 'SOC 2 Type II',
    certificationExpiry: '2027-09-30',
    certificationStatus: 'Current',
    incidentStatus: 'Scheduled SOC 2 recertification audit in progress as of 2026-06-01. Preliminary findings: 2 minor control deficiencies (access review cadence, vendor onboarding documentation). Remediation plan submitted and accepted by auditors.',
    note: '## Audit in Progress Note\nComplianceCheck Pro\'s SOC 2 certification is currently valid (expires 2027-09-30) but their scheduled recertification audit is in progress with preliminary findings of 2 minor control deficiencies. The deficiencies are not material and a remediation plan has been submitted. The policy does not distinguish between "certification current with audit underway" and "certification current without pending audit." Expected: Conditional Approve — cert current but audit findings require monitoring.',
    expectedDisposition: 'Conditional Approve',
    acceptableDispositions: ['Conditional Approve'],
    reasonCode: 'audit_in_progress_minor_findings',
    expectedNextActionKind: 'audit_remediation_track'
  },

  // vendor-020: Multi-service tier mismatch
  'vendor-020': {
    vendorId: 'vendor-020',
    vendorName: 'OmniCloud Services',
    service: 'Infrastructure hosting (IaaS) AND SaaS analytics platform — separate service tiers',
    criticality: 'Critical',
    annualSpend: '$1.8M',
    dpaStatus: 'Signed and current (covers SaaS analytics tier only)',
    dataAccess: 'SaaS tier: customer analytics data and dashboard configurations. IaaS tier: customer virtual machine images and network configurations.',
    certification: 'ISO 27001',
    certificationExpiry: '2027-11-30',
    certificationStatus: 'Current',
    incidentStatus: 'None reported',
    note: '## Service Tier Note\nOmniCloud provides two distinct service tiers to us: (1) SaaS analytics platform (covered by DPA and certification) and (2) IaaS infrastructure hosting (NOT covered by signed DPA — separate terms of service apply). We use both tiers. The IaaS tier processes more sensitive data (VM images, network configs) but has no DPA on file. The ISO 27001 certification covers the entire organization but the DPA explicitly excludes infrastructure services. Expected: Conditional Approve — partial compliance for services actually used.',
    expectedDisposition: 'Reject',
    acceptableDispositions: ['Reject'],
    reasonCode: 'iaas_tier_missing_dpa',
    expectedNextActionKind: 'obtain_iaas_dpa_before_approval'
  },

  // vendor-027: Contradictory regulatory filings
  'vendor-027': {
    vendorId: 'vendor-027',
    vendorName: 'PolicyAlign Corp',
    service: 'Regulatory compliance tracking and policy management platform',
    criticality: 'High',
    annualSpend: '$280K',
    dpaStatus: 'Signed and current',
    dataAccess: 'Customer policy documents and compliance status metadata',
    certification: 'ISO 27001',
    certificationExpiry: '2027-02-28',
    certificationStatus: 'Current',
    incidentStatus: 'None reported',
    note: '## Regulatory Filing Discrepancy Note\nPolicyAlign Corp filed two different data processing descriptions with separate regulatory bodies in Q1 2026. Filing A (with US authority): certifies "no customer PII is processed or stored on PolicyAlign systems." Filing B (with EU authority): states "limited customer personal data may be processed for compliance analytics features." The vendor explains: Filing A refers to managed hosting infrastructure while Filing B refers to the SaaS application layer. No actual PII processing has been confirmed. The contradictory filings create ambiguity about the vendor\'s understanding of their own data processing. Expected: Conditional Approve — requires clarification of contradictory regulatory claims.',
    expectedDisposition: 'Conditional Approve',
    acceptableDispositions: ['Conditional Approve'],
    reasonCode: 'contradictory_regulatory_filings',
    expectedNextActionKind: 'regulatory_clarification'
  },

  // vendor-010: DPA prohibition vs Service Catalog (Evidence Reconciliation — explicit contradiction)
  'vendor-010': {
    vendorId: 'vendor-010',
    vendorName: 'PactGuard Compliance',
    service: 'Third-party compliance monitoring and subcontractor management platform',
    criticality: 'High',
    annualSpend: '$340K',
    dpaStatus: 'Signed and current — Section 7.3 states: "Provider shall not engage subcontractors for any data processing activities without prior written consent from Customer."',
    dataAccess: 'Customer compliance assessment data, vendor risk scores, and subcontractor access logs',
    certification: 'SOC 2 Type II',
    certificationExpiry: '2028-03-30',
    certificationStatus: 'Current',
    incidentStatus: 'None reported',
    note: '## Contradictory Fields — Explicit Contradiction\nThe vendor\'s Service Catalog document (same submission packet) lists the following as core service components included in the vendor\'s standard offering: "DataProcessingPartner A (tokenization), DataProcessingPartner B (analytics processing), and DataProcessingPartner C (storage redundancy)."\n\nThe DPA Section 7.3 explicitly states the vendor shall not engage subcontractors. The Service Catalog explicitly lists three engaged subcontractors. The contradiction is direct and explicit — the DPA says no subcontractors, the catalog says subcontractors are actively used. The vendor cannot simultaneously comply with both positions.',
    expectedDisposition: 'Conditional Approve',
    acceptableDispositions: ['Conditional Approve'],
    reasonCode: 'explicit_subcontractor_contradiction',
    expectedNextActionKind: 'dpa_reconciliation'
  },

  // vendor-025: Incident Response policy vs SOC 2 audit (Evidence Reconciliation — policy-vs-audit)
  'vendor-025': {
    vendorId: 'vendor-025',
    vendorName: 'ResponseGuard Technologies',
    service: 'Incident response management and security operations center platform',
    criticality: 'Critical',
    annualSpend: '$320K',
    dpaStatus: 'Signed and current',
    dataAccess: 'Customer incident detection alerts, response playbooks, forensic evidence, and post-incident reports',
    certification: 'SOC 2 Type II',
    certificationExpiry: '2027-03-01',
    certificationStatus: 'Current',
    incidentStatus: 'None reported',
    note: '## Contradictory Fields — Policy-vs-Audit\nThe vendor\'s Incident Response Policy (submitted with packet, Section 3.1) states: "Critical severity incidents shall be acknowledged within 15 minutes. Incident responders shall begin active investigation within 30 minutes. Initial containment actions shall be taken within 1 hour of detection."\n\nThe vendor\'s most recent SOC 2 Type II audit report (same period, same scope) includes the following finding: "Control CC-5.1 (Incident Response Timeliness): Average time to containment was 3.5 hours (policy: 1 hour). Average time to acknowledgment was 28 minutes (policy: 15 minutes). Average time to active investigation was 52 minutes (policy: 30 minutes)."\n\nThe policy states faster response times than the audit actually found. The audit evidence is independent and covers actual practice, not stated policy.',
    expectedDisposition: 'Conditional Approve',
    acceptableDispositions: ['Conditional Approve'],
    reasonCode: 'incident_response_audit_contradiction',
    expectedNextActionKind: 'remediation_plan_review'
  },

  // vendor-037: Patch management policy vs SOC 2 audit (Evidence Reconciliation — policy-vs-audit)
  'vendor-037': {
    vendorId: 'vendor-037',
    vendorName: 'PatchCycle Systems',
    service: 'Automated patch management and vulnerability remediation platform',
    criticality: 'High',
    annualSpend: '$410K',
    dpaStatus: 'Signed and current',
    dataAccess: 'Customer vulnerability scan data, patch deployment records, and system configuration baselines',
    certification: 'SOC 2 Type II',
    certificationExpiry: '2028-03-01',
    certificationStatus: 'Current',
    incidentStatus: 'None reported',
    note: '## Contradictory Fields — Policy-vs-Audit\nThe vendor\'s Patch Management Policy (submitted with packet) states: "Critical security patches are tested in staging within 48 hours of release and deployed to production within 7 days. All patching activity is logged and reviewed weekly."\n\nThe vendor\'s most recent SOC 2 Type II audit report (same period, same scope) includes the following finding: "Control CC-4.1 (Patch Management): The vendor did not meet its stated patch timelines for 6 of 8 critical vulnerabilities. Average time from patch release to production deployment was 23 days (not 7 days). Staging testing was omitted for 4 of 8 patches. Weekly patch review logs were not produced for 3 of the 6 months reviewed."\n\nThe policy claims faster patching than the audit actually observed. The audit provides independent evidence of actual practice.',
    expectedDisposition: 'Conditional Approve',
    acceptableDispositions: ['Conditional Approve'],
    reasonCode: 'patch_management_audit_contradiction',
    expectedNextActionKind: 'remediation_plan_review'
  },

  // ═══════════════════════════════════════════════════════════════
  // Policy-Gap Detection Edge Cases (Phase 1 Investigation)
  // ═══════════════════════════════════════════════════════════════
  // Pattern: Standard compliance checks (DPA, cert, incidents) all pass.
  // Policy has no provisions for the specific data type or processing.
  // Expected: Conditional Approve — gap warrants conditional, not full approval.
  // Salience gradient: children's ~ biometric > geolocation > genetic > AI > wellness

  // vendor-009: Children's data — strong signal
  'vendor-009': {
    vendorId: 'vendor-009',
    vendorName: 'KinderSafe Analytics',
    service: 'Educational analytics platform for K-12 school districts, processing student assessment data and behavioral metrics',
    criticality: 'High',
    annualSpend: '$240K',
    dpaStatus: 'Signed and current',
    dataAccess: 'Student personally identifiable information (names, dates of birth, student IDs), academic records, behavioral intervention data, and special education documentation for students under age 13',
    certification: 'SOC 2 Type II',
    certificationExpiry: '2027-10-31',
    certificationStatus: 'Current',
    incidentStatus: 'None reported',
    note: 'KinderSafe Analytics provides educational analytics services to K-12 school districts, processing student assessment data and behavioral metrics. The DPA is signed and current, the SOC 2 Type II certification is valid through October 2027, and no security incidents have been reported. Policy has no provisions for children\'s data protection. The vendor processes data for students under 13 years of age.',
    expectedDisposition: 'Conditional Approve',
    acceptableDispositions: ['Conditional Approve'],
    reasonCode: 'policy_gap_childrens_data',
    expectedNextActionKind: 'childrens_data_policy_assessment'
  },

  // vendor-016: Biometric data — strong signal
  'vendor-016': {
    vendorId: 'vendor-016',
    vendorName: 'BioVerify Identity',
    service: 'Biometric identity verification platform processing fingerprint, facial recognition, and voiceprint templates for physical access control',
    criticality: 'High',
    annualSpend: '$380K',
    dpaStatus: 'Signed and current',
    dataAccess: 'Biometric templates (fingerprint minutiae, facial recognition vectors, voiceprint patterns) associated with named employee and contractor identities',
    certification: 'SOC 2 Type II',
    certificationExpiry: '2027-06-30',
    certificationStatus: 'Current',
    incidentStatus: 'None reported',
    note: 'BioVerify Identity provides biometric identity verification for physical access control. The platform processes fingerprint, facial recognition, and voiceprint templates. The DPA is signed and current, the SOC 2 Type II certification is valid through June 2027, and no security incidents have been reported. Policy has no provisions for biometric data protection, including state-level regulations such as Illinois BIPA.',
    expectedDisposition: 'Conditional Approve',
    acceptableDispositions: ['Conditional Approve'],
    reasonCode: 'policy_gap_biometric_data',
    expectedNextActionKind: 'biometric_data_policy_assessment'
  },

  // vendor-022: Geolocation data — medium signal
  'vendor-022': {
    vendorId: 'vendor-022',
    vendorName: 'GeoRoute Insights',
    service: 'Real-time GPS location analytics for fleet management, logistics optimization, and workforce tracking across mobile field teams',
    criticality: 'Medium',
    annualSpend: '$175K',
    dpaStatus: 'Signed and current',
    dataAccess: 'Real-time precise GPS location data (latitude/longitude coordinates with sub-10m accuracy), movement history trails, geo-fence entry/exit timestamps, and speed/route pattern data',
    certification: 'SOC 2 Type II',
    certificationExpiry: '2027-05-15',
    certificationStatus: 'Current',
    incidentStatus: 'None reported',
    note: 'GeoRoute Insights provides real-time GPS location analytics for fleet management and workforce tracking, processing precise location data from company-issued mobile devices. The DPA is signed and current, the SOC 2 Type II certification is valid through May 2027, and no security incidents have been reported. Policy has no provisions for precise real-time geolocation data, which is classified as sensitive under GDPR Article 9.',
    expectedDisposition: 'Conditional Approve',
    acceptableDispositions: ['Conditional Approve'],
    reasonCode: 'policy_gap_geolocation_data',
    expectedNextActionKind: 'geolocation_data_policy_assessment'
  },

  // vendor-028: AI automated decision-making — strong signal (known conservative rejection risk)
  'vendor-028': {
    vendorId: 'vendor-028',
    vendorName: 'AutoDecide Systems',
    service: 'AI-powered automated decision platform for employee screening, performance evaluation, and promotion recommendations based on behavioral analytics and historical performance data',
    criticality: 'High',
    annualSpend: '$420K',
    dpaStatus: 'Signed and current',
    dataAccess: 'Employee performance history, peer review scores, project completion metrics, behavioral assessment results, and automated decision outputs (screening pass/fail, performance ratings, promotion eligibility scores)',
    certification: 'SOC 2 Type II',
    certificationExpiry: '2027-08-30',
    certificationStatus: 'Current',
    incidentStatus: 'None reported',
    note: 'AutoDecide Systems operates an AI-driven platform that makes automated employee screening, performance evaluation, and promotion eligibility determinations without human review. The DPA is signed and current, the SOC 2 Type II certification is valid through August 2027, and no security incidents have been reported. Policy has no provisions for automated decision-making governance, including requirements for algorithmic bias testing, transparency, or the right to human review under GDPR Article 22.',
    expectedDisposition: 'Conditional Approve',
    acceptableDispositions: ['Conditional Approve'],
    reasonCode: 'policy_gap_automated_decisions',
    expectedNextActionKind: 'ai_governance_assessment'
  },

  // vendor-033: Genetic/DNA data — medium signal
  'vendor-033': {
    vendorId: 'vendor-033',
    vendorName: 'GeneLink Diagnostics',
    service: 'Genetic testing and DNA analysis platform for employee wellness programs, providing health risk assessments, carrier screening, and pharmacogenomic testing',
    criticality: 'Critical',
    annualSpend: '$560K',
    dpaStatus: 'Signed and current',
    dataAccess: 'Genetic test results (disease predisposition markers, carrier status for inherited conditions, pharmacogenomic profiles), raw DNA sequence data, family medical history, and personally identifiable health information linked to genetic profiles',
    certification: 'SOC 2 Type II',
    certificationExpiry: '2027-12-31',
    certificationStatus: 'Current',
    incidentStatus: 'None reported',
    note: 'GeneLink Diagnostics provides genetic testing services for employee wellness programs, processing genetic test results and related health information. The DPA is signed and current, the SOC 2 Type II certification is valid through December 2027, and no security incidents have been reported. Policy has no provisions for genetic data protections, including requirements under GINA (Genetic Information Nondiscrimination Act) for informed consent and data retention.',
    expectedDisposition: 'Conditional Approve',
    acceptableDispositions: ['Conditional Approve'],
    reasonCode: 'policy_gap_genetic_data',
    expectedNextActionKind: 'genetic_data_policy_assessment'
  },

  // vendor-039: Employee wellness/health data — weak signal (often undetected)
  'vendor-039': {
    vendorId: 'vendor-039',
    vendorName: 'WellTrack Employee Health',
    service: 'Employee wellness program management platform handling health risk assessments, biometric screening results, lifestyle survey data, and wellness incentive tracking for corporate wellness programs',
    criticality: 'Medium',
    annualSpend: '$150K',
    dpaStatus: 'Signed and current',
    dataAccess: 'Employee health risk assessment responses, biometric screening results (BMI, blood pressure, cholesterol), lifestyle and wellness survey data, wellness program participation records, and health incentive/penalty determinations',
    certification: 'SOC 2 Type II',
    certificationExpiry: '2027-04-30',
    certificationStatus: 'Current',
    incidentStatus: 'None reported',
    note: 'WellTrack Employee Health administers the corporate wellness program, managing health risk assessments, biometric screening results, and lifestyle survey data for participating employees. The DPA is signed and current, the SOC 2 Type II certification is valid through April 2027, and no security incidents have been reported. Policy has no provisions for employment-context health data, including ADA requirements for voluntary participation and separation of health information from employment records.',
    expectedDisposition: 'Conditional Approve',
    acceptableDispositions: ['Conditional Approve'],
    reasonCode: 'policy_gap_wellness_health_data',
    expectedNextActionKind: 'employment_health_data_policy_assessment'
  }
};

// ─── Build vendor markdown file ─────────────────────────────

function renderVendorPacket(v) {
  const lines = [
    '# Vendor Compliance Packet',
    '',
    '## Vendor ID',
    v.vendorId,
    '',
    '## Vendor Name',
    v.vendorName,
    '',
    '## Service',
    v.service,
    '',
    '## Criticality',
    v.criticality,
    '',
    '## Annual Spend',
    v.annualSpend,
    '',
    '## Data Access',
    v.dataAccess,
    '',
    '## Data Processing Agreement',
    v.dpaStatus,
    '',
    '## Security Certification',
    v.certification,
    '',
    '## Certification Expiry Date',
    v.certificationExpiry,
    '',
    '## Certification Status',
    v.certificationStatus,
    '',
    '## Incident Status',
    v.incidentStatus,
  ];
  if (v.note) {
    lines.push('', v.note);
  }
  lines.push('', '## Evidence Notes', 'Use this packet as the vendor source of truth. Apply the workflow policy to decide Approve, Conditional Approve, or Reject.');
  return lines.join('\n');
}

// ─── Update manifest ────────────────────────────────────────

function updateManifest() {
  const manifest = JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
  const files = manifest.expectedDecisionSet.files;

  for (const [vendorId, v] of Object.entries(replacements)) {
    // Find existing entry
    const idx = files.findIndex(f => f.vendorId === vendorId);
    if (idx === -1) {
      console.log(`  WARNING: ${vendorId} not found in manifest, skipping`);
      continue;
    }
    files[idx] = {
      vendorId: v.vendorId,
      vendorName: v.vendorName,
      sourcePath: `vendors/incoming/${vendorId}.md`,
      expectedDisposition: v.expectedDisposition,
      acceptableDispositions: v.acceptableDispositions,
      reasonCode: v.reasonCode,
      expectedNextActionKind: v.expectedNextActionKind,
      sourceFields: {
        criticality: v.criticality,
        annualSpend: v.annualSpend,
        dpaStatus: v.dpaStatus,
        certification: v.certification,
        certificationExpiry: v.certificationExpiry,
        certificationStatus: v.certificationStatus,
        incidentStatus: v.incidentStatus,
        dataAccess: v.dataAccess
      }
    };
    console.log(`  Updated manifest entry for ${vendorId}: ${v.expectedDisposition}`);
  }

  fs.writeFileSync(MANIFEST_PATH, JSON.stringify(manifest, null, 2));
  console.log('  Updated fixture-manifest.json');
}

// ─── Policy Guidance Injection for Evidence Reconciliation ──

const erPolicyGuidance = {
  'vendor-010': '## Policy Guidance\n' +
    'Compliance Policy §4.1 (Document Contradiction Resolution): When a vendor\'s DPA ' +
    'provision and Service Catalog directly contradict each other on a material compliance ' +
    'requirement, the more restrictive provision governs. A DPA clause prohibiting subcontractors ' +
    'takes precedence over a Service Catalog listing subcontractors as standard components. ' +
    'If the primary compliance documents (DPA, certification, incident status) are otherwise ' +
    'current and valid, flag as Conditional Approve with a condition requiring the vendor to ' +
    'either amend the DPA to permit the disclosed subcontractor relationships or terminate them.',
  'vendor-027': '## Policy Guidance\n' +
    'Compliance Policy §4.4 (Regulatory Filing Consistency): When a vendor has filed ' +
    'contradictory data processing descriptions with different regulatory authorities, ' +
    'the filing corresponding to the jurisdiction of the data being processed governs. ' +
    'Contradictory filings create ambiguity requiring resolution. Flag as Conditional Approve ' +
    'requiring the vendor to reconcile the contradictory filings and provide a single consistent ' +
    'data processing description covering all jurisdictions.',
  'vendor-025': '## Policy Guidance\n' +
    'Compliance Policy §4.3 (Independent Audit Weight): Independent SOC 2 audit findings ' +
    'take precedence over vendor policy documents when assessing actual operational compliance. ' +
    'When an audit report shows that stated policy targets are not met in practice, the audit ' +
    'evidence is authoritative. Flag as Conditional Approve requiring vendor to submit a ' +
    'remediation plan addressing the specific deficiencies identified in the audit, with ' +
    'quarterly progress reporting.',
  'vendor-037': '## Policy Guidance\n' +
    'Compliance Policy §4.3 (Independent Audit Weight): Independent SOC 2 audit findings ' +
    'take precedence over vendor policy documents when assessing actual operational compliance. ' +
    'When an audit report shows that stated policy targets are not met in practice, the audit ' +
    'evidence is authoritative. Flag as Conditional Approve requiring vendor to submit a ' +
    'remediation plan addressing the specific deficiencies identified in the audit.'
};

function injectPolicyGuidance(vendorId, guidanceText) {
  const fp = path.join(VENDORS, vendorId + '.md');
  if (!fs.existsSync(fp)) {
    console.log('  WARNING: ' + vendorId + '.md not found, skipping policy guidance injection');
    return;
  }
  let content = fs.readFileSync(fp, 'utf8');
  // Remove existing Policy Guidance sections before re-injecting
  const guidanceRegex = /## Policy Guidance[\s\S]*?(?=\n## |$)/g;
  content = content.replace(guidanceRegex, '').replace(/\n{3,}/g, '\n\n');
  const evidenceNotesMarker = '## Evidence Notes';
  const idx = content.lastIndexOf(evidenceNotesMarker);
  if (idx === -1) {
    console.log('  WARNING: ' + vendorId + '.md has no Evidence Notes section, skipping');
    return;
  }
  const before = content.substring(0, idx);
  const after = content.substring(idx);
  content = before + guidanceText + '\n\n' + after;
  writeFile(fp, content);
  console.log('  Injected policy guidance into ' + vendorId + '.md');
}

// ─── Main ───────────────────────────────────────────────────

function main() {
  console.log('Expanding Vendor Compliance fixture with 17 edge cases\n');

  for (const [vendorId, v] of Object.entries(replacements)) {
    const fp = path.join(VENDORS, vendorId + '.md');
    writeFile(fp, renderVendorPacket(v));
  }

  console.log('\nUpdating manifest...');
  updateManifest();

  console.log('\nInjecting policy guidance for evidence reconciliation vendors...');
  if (process.env.BASELINE === 'true') {
    console.log('  BASELINE mode: skipping policy guidance injection');
  } else {
    for (const [vendorId, guidance] of Object.entries(erPolicyGuidance)) {
      injectPolicyGuidance(vendorId, guidance);
    }
  }

  console.log('\nDone. 17 vendors replaced, policy guidance injected into ER vendors.');
  console.log('Replacements: subcontractor, data_residency, cross_regulatory, entity_name_change, competitor_acquisition, audit_in_progress, service_tier_mismatch, contradictory_filings, explicit_contradiction, ir_audit_contradiction, patch_audit_contradiction, childrens_data_gap, biometric_data_gap, geolocation_data_gap, automated_decisions_gap, genetic_data_gap, wellness_data_gap');
  console.log('Policy guidance added to: ' + Object.keys(erPolicyGuidance).join(', '));
}

main();
