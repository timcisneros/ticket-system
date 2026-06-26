#!/usr/bin/env node
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FIXTURES_PATH = path.join(ROOT, 'fixtures', 'workspace-catalog', 'fixtures.json');
const CONTRACTS_PATH = path.join(ROOT, 'fixtures', 'workspace-catalog', 'scenario-contracts.json');
const GENERATOR_PATH = path.join(ROOT, 'scripts', 'generate-workspace-fixtures.js');

const REQUIRED_FIELDS = [
  'id',
  'fixtureId',
  'representativeTicketId',
  'name',
  'objective',
  'kind',
  'domain',
  'sizeClass',
  'allowedMutationZones',
  'forbiddenMutationZones',
  'requiredArtifacts',
  'requiredArtifactChecks',
  'forbiddenSourceChecks',
  'requiredEvidenceChecks',
  'targetProviderChecks',
  'expectedTicketOutcome',
  'expectedRunOutcome',
  'verificationNotes',
  'nonGoals'
];
const ARTIFACT_CHECK_TYPES = new Set([
  'fileExists',
  'fileContains',
  'csvHasHeader',
  'jsonHasField',
  'markdownHasHeading',
  'pathUnderAllowedZone',
  'pathDoesNotExist'
]);
const SOURCE_CHECK_TYPES = new Set([
  'fileUnchanged',
  'pathDoesNotExist',
  'noMutationUnderForbiddenZone',
  'noMutationUnderProtectedPath',
  'noUnexpectedSourceMutation'
]);
const EVIDENCE_CHECK_TYPES = new Set([
  'mutationReceiptsPresent',
  'readReceiptsPresent',
  'workspaceOperationEventsPresent',
  'authorityDeniedEventPresent',
  'replaySnapshotPathPresent',
  'noWorkspaceMutation'
]);
const TARGET_CHECK_TYPES = new Set(['targetIdPresent', 'targetKindPresent']);
const REQUIRED_NON_GOALS = ['connector behavior', 'customer data', 'ambient watching', 'model routing'];

function isSafeRelativePath(value) {
  if (typeof value !== 'string' || !value || path.isAbsolute(value) || value.includes('\0')) return false;
  const normalized = path.posix.normalize(value.replace(/\\/g, '/'));
  return normalized !== '..' && !normalized.startsWith('../');
}

function pathMatchesZone(relativePath, zone) {
  const normalizedPath = relativePath.replace(/\\/g, '/');
  const normalizedZone = zone.replace(/\\/g, '/');
  if (normalizedZone.endsWith('/**')) {
    const prefix = normalizedZone.slice(0, -3);
    return normalizedPath === prefix || normalizedPath.startsWith(`${prefix}/`);
  }
  return normalizedPath === normalizedZone;
}

function assertCheckShape(contract, check, vocabulary, collectionName) {
  assert(check && typeof check === 'object' && !Array.isArray(check), `${contract.id}.${collectionName} entries must be objects`);
  assert(vocabulary.has(check.type), `${contract.id} uses unknown ${collectionName} type: ${check.type}`);
  if (['fileExists', 'fileContains', 'csvHasHeader', 'jsonHasField', 'markdownHasHeading', 'pathUnderAllowedZone', 'pathDoesNotExist', 'fileUnchanged', 'noMutationUnderProtectedPath'].includes(check.type)) {
    assert(isSafeRelativePath(check.path), `${contract.id}/${check.type} requires a safe relative path`);
  }
  if (check.type === 'fileContains') assert(typeof check.value === 'string' && check.value.length > 0, `${contract.id}/fileContains requires value`);
  if (check.type === 'csvHasHeader') assert(Array.isArray(check.headers) && check.headers.length > 0, `${contract.id}/csvHasHeader requires headers`);
  if (check.type === 'jsonHasField') assert(typeof check.field === 'string' && check.field.length > 0, `${contract.id}/jsonHasField requires field`);
  if (check.type === 'markdownHasHeading') assert(typeof check.heading === 'string' && check.heading.length > 0, `${contract.id}/markdownHasHeading requires heading`);
  if (check.type === 'noMutationUnderForbiddenZone') assert(typeof check.zone === 'string' && check.zone.length > 0, `${contract.id}/noMutationUnderForbiddenZone requires zone`);
}

function assertFixturePreconditions(fixture, fixtureRoot) {
  for (const relativePath of [...fixture.expectedUsefulFiles, ...fixture.distractingFiles, ...fixture.protectedPathExamples]) {
    assert(fs.existsSync(path.join(fixtureRoot, relativePath)), `${fixture.id} precondition path missing: ${relativePath}`);
  }
  for (const artifact of fixture.expectedArtifacts) {
    assert(!fs.existsSync(path.join(fixtureRoot, artifact)), `${fixture.id} artifact must not be pre-generated: ${artifact}`);
    assert(fs.existsSync(path.dirname(path.join(fixtureRoot, artifact))), `${fixture.id} artifact parent missing: ${artifact}`);
  }
}

function main() {
  const fixtureCatalog = JSON.parse(fs.readFileSync(FIXTURES_PATH, 'utf8'));
  const contractCatalog = JSON.parse(fs.readFileSync(CONTRACTS_PATH, 'utf8'));
  assert.strictEqual(contractCatalog.schemaVersion, 1, 'scenario contract schemaVersion must be 1');
  assert(Array.isArray(contractCatalog.contracts), 'contracts must be an array');
  assert.strictEqual(contractCatalog.contracts.length, 16, 'exactly 16 scenario contracts are required');

  const fixturesById = new Map(fixtureCatalog.fixtures.map(fixture => [fixture.id, fixture]));
  const contractIds = contractCatalog.contracts.map(contract => contract.id);
  assert.strictEqual(new Set(contractIds).size, contractIds.length, 'scenario contract ids must be unique');

  const coverage = new Map(fixtureCatalog.fixtures.map(fixture => [fixture.id, { artifact_success: 0, blocked_correctly: 0 }]));

  for (const contract of contractCatalog.contracts) {
    for (const field of REQUIRED_FIELDS) assert(contract[field] !== undefined, `${contract.id || '(unknown)'}.${field} is required`);
    assert(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(contract.id), `invalid contract id: ${contract.id}`);
    assert(['artifact_success', 'blocked_correctly'].includes(contract.kind), `${contract.id} has invalid kind`);

    const fixture = fixturesById.get(contract.fixtureId);
    assert(fixture, `${contract.id} references unknown fixture ${contract.fixtureId}`);
    coverage.get(fixture.id)[contract.kind] += 1;
    assert.strictEqual(contract.domain, fixture.domain, `${contract.id} domain must match fixture`);
    assert.strictEqual(contract.sizeClass, fixture.sizeClass, `${contract.id} sizeClass must match fixture`);
    assert.deepStrictEqual(contract.allowedMutationZones, fixture.allowedMutationZones, `${contract.id} must inherit allowed mutation zones`);
    assert.deepStrictEqual(contract.forbiddenMutationZones, fixture.forbiddenMutationZones, `${contract.id} must inherit forbidden mutation zones`);

    const ticket = fixture.supportedTicketExamples.find(item => item.id === contract.representativeTicketId);
    assert(ticket, `${contract.id} references unknown representative ticket ${contract.representativeTicketId}`);
    assert.strictEqual(contract.objective, ticket.objective, `${contract.id} objective must match representative ticket`);

    assert(Array.isArray(contract.requiredArtifacts), `${contract.id}.requiredArtifacts must be an array`);
    assert(Array.isArray(contract.requiredArtifactChecks) && contract.requiredArtifactChecks.length > 0, `${contract.id} requires deterministic artifact checks`);
    assert(Array.isArray(contract.forbiddenSourceChecks) && contract.forbiddenSourceChecks.length > 0, `${contract.id} requires deterministic source checks`);
    assert(Array.isArray(contract.requiredEvidenceChecks) && contract.requiredEvidenceChecks.length > 0, `${contract.id} requires evidence checks`);
    assert(Array.isArray(contract.targetProviderChecks) && contract.targetProviderChecks.length > 0, `${contract.id} requires target-provider checks`);
    assert(Array.isArray(contract.verificationNotes) && contract.verificationNotes.length > 0, `${contract.id} requires verification notes`);
    assert.deepStrictEqual(contract.nonGoals, REQUIRED_NON_GOALS, `${contract.id} must preserve the milestone non-goals`);

    for (const check of contract.requiredArtifactChecks) assertCheckShape(contract, check, ARTIFACT_CHECK_TYPES, 'requiredArtifactChecks');
    for (const check of contract.forbiddenSourceChecks) {
      assertCheckShape(contract, check, SOURCE_CHECK_TYPES, 'forbiddenSourceChecks');
      if (check.type === 'noMutationUnderForbiddenZone') {
        assert(contract.forbiddenMutationZones.includes(check.zone), `${contract.id} checks undeclared forbidden zone ${check.zone}`);
      }
      if (['fileUnchanged', 'noMutationUnderProtectedPath'].includes(check.type)) {
        assert(fixture.protectedPathExamples.includes(check.path), `${contract.id} checks undeclared protected path ${check.path}`);
      }
    }
    for (const checkType of contract.requiredEvidenceChecks) assert(EVIDENCE_CHECK_TYPES.has(checkType), `${contract.id} uses unknown evidence check: ${checkType}`);
    for (const check of contract.targetProviderChecks) {
      assertCheckShape(contract, check, TARGET_CHECK_TYPES, 'targetProviderChecks');
      if (check.type === 'targetIdPresent') assert.strictEqual(check.expected, 'local-workspace', `${contract.id} target id mismatch`);
      if (check.type === 'targetKindPresent') assert.strictEqual(check.expected, 'localWorkspace', `${contract.id} target kind mismatch`);
    }

    const operationalText = JSON.stringify({
      name: contract.name,
      objective: contract.objective,
      checks: [contract.requiredArtifactChecks, contract.forbiddenSourceChecks, contract.requiredEvidenceChecks, contract.targetProviderChecks]
    }).toLowerCase();
    for (const prohibited of ['google drive', 'slack', 'discord', 'github', 'connector', 'customer data', 'watcher', 'ambient', 'model routing']) {
      assert(!operationalText.includes(prohibited), `${contract.id} implies prohibited behavior: ${prohibited}`);
    }

    if (contract.kind === 'artifact_success') {
      assert(contract.requiredArtifacts.length > 0, `${contract.id} requires artifacts`);
      assert.deepStrictEqual(contract.requiredArtifacts, ticket.expectedArtifacts, `${contract.id} artifacts must match representative ticket`);
      assert.strictEqual(contract.expectedTicketOutcome, 'completed', `${contract.id} ticket outcome mismatch`);
      assert.strictEqual(contract.expectedRunOutcome, 'completed', `${contract.id} run outcome mismatch`);
      for (const artifact of contract.requiredArtifacts) {
        assert(fixture.expectedArtifacts.includes(artifact), `${contract.id} uses undeclared artifact ${artifact}`);
        assert(contract.allowedMutationZones.some(zone => pathMatchesZone(artifact, zone)), `${contract.id} artifact is outside allowed zones: ${artifact}`);
        assert(!contract.forbiddenMutationZones.some(zone => pathMatchesZone(artifact, zone)), `${contract.id} artifact is inside forbidden zone: ${artifact}`);
        assert(contract.requiredArtifactChecks.some(check => check.type === 'fileExists' && check.path === artifact), `${contract.id} lacks fileExists for ${artifact}`);
        assert(contract.requiredArtifactChecks.some(check => check.type === 'pathUnderAllowedZone' && check.path === artifact), `${contract.id} lacks pathUnderAllowedZone for ${artifact}`);
      }
      for (const required of ['mutationReceiptsPresent', 'readReceiptsPresent', 'workspaceOperationEventsPresent', 'replaySnapshotPathPresent']) {
        assert(contract.requiredEvidenceChecks.includes(required), `${contract.id} lacks evidence check ${required}`);
      }
    } else {
      assert.strictEqual(contract.requiredArtifacts.length, 0, `${contract.id} blocked contract must not require artifacts`);
      assert(contract.blockedCorrectlyCaseId, `${contract.id} blockedCorrectlyCaseId is required`);
      assert(isSafeRelativePath(contract.blockedPath), `${contract.id} blockedPath must be safe`);
      const blockedCase = fixture.blockedCorrectlyCases.find(item => item.id === contract.blockedCorrectlyCaseId);
      assert(blockedCase, `${contract.id} references unknown blocked case ${contract.blockedCorrectlyCaseId}`);
      assert.strictEqual(ticket.blockedCorrectlyCaseId, blockedCase.id, `${contract.id} ticket and blocked case mismatch`);
      assert(fixture.protectedPathExamples.includes(contract.blockedPath), `${contract.id} blockedPath must be a protected fixture example`);
      assert(contract.forbiddenMutationZones.some(zone => pathMatchesZone(contract.blockedPath, zone)), `${contract.id} blockedPath is not forbidden`);
      assert.strictEqual(contract.expectedTicketOutcome, 'blocked', `${contract.id} ticket outcome mismatch`);
      assert.strictEqual(contract.expectedRunOutcome, 'authority_denied', `${contract.id} run outcome mismatch`);
      for (const required of ['authorityDeniedEventPresent', 'noWorkspaceMutation', 'replaySnapshotPathPresent']) {
        assert(contract.requiredEvidenceChecks.includes(required), `${contract.id} lacks evidence check ${required}`);
      }
      assert(contract.forbiddenSourceChecks.some(check => check.type === 'fileUnchanged' && check.path === contract.blockedPath), `${contract.id} lacks fileUnchanged for blocked path`);
      assert(contract.forbiddenSourceChecks.some(check => check.type === 'noMutationUnderProtectedPath' && check.path === contract.blockedPath), `${contract.id} lacks protected-path mutation check`);
    }
  }

  for (const fixture of fixtureCatalog.fixtures) {
    assert(coverage.get(fixture.id).artifact_success >= 1, `${fixture.id} lacks artifact-success coverage`);
    assert(coverage.get(fixture.id).blocked_correctly >= 1, `${fixture.id} lacks blocked-correctly coverage`);
  }

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'business-scenario-contracts-test-'));
  const outputRoot = path.join(tempRoot, 'fixtures');
  try {
    const generated = spawnSync(process.execPath, [GENERATOR_PATH, '--out', outputRoot, '--all', '--test-mode'], {
      cwd: ROOT,
      encoding: 'utf8'
    });
    assert.strictEqual(generated.status, 0, `fixture generation failed:\n${generated.stderr}`);
    for (const fixture of fixtureCatalog.fixtures) assertFixturePreconditions(fixture, path.join(outputRoot, fixture.id));
    for (const contract of contractCatalog.contracts.filter(item => item.kind === 'blocked_correctly')) {
      assert(fs.existsSync(path.join(outputRoot, contract.fixtureId, contract.blockedPath)), `${contract.id} blocked path missing after generation`);
    }
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  console.log('business-scenario-contracts-test: PASS (16 contracts, 8 artifact-success, 8 blocked-correctly)');
}

try {
  main();
} catch (error) {
  console.error(`business-scenario-contracts-test: FAIL\n${error.stack || error.message}`);
  process.exit(1);
}
