#!/usr/bin/env node
const assert = require('assert');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CATALOG_PATH = path.join(ROOT, 'fixtures', 'workspace-catalog', 'fixtures.json');
const GENERATOR_PATH = path.join(ROOT, 'scripts', 'generate-workspace-fixtures.js');
const REQUIRED_FIELDS = [
  'id',
  'name',
  'domain',
  'sizeClass',
  'purpose',
  'generator',
  'targetStructure',
  'expectedUsefulFiles',
  'distractingFiles',
  'protectedPathExamples',
  'allowedMutationZones',
  'forbiddenMutationZones',
  'expectedArtifacts',
  'supportedTicketExamples',
  'verificationNotes',
  'blockedCorrectlyCases',
  'demoNarrative',
  'generation'
];
const EXPECTED_DOMAINS = [
  'legal intake',
  'vendor compliance',
  'customer support',
  'shared-drive cleanup',
  'billing reconciliation',
  'contract packet prep',
  'status reporting',
  'compliance digest'
];

function runGenerator(args) {
  return spawnSync(process.execPath, [GENERATOR_PATH, ...args], {
    cwd: ROOT,
    encoding: 'utf8'
  });
}

function walk(root) {
  const files = [];
  const directories = [];
  function visit(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(directory, entry.name);
      const relative = path.relative(root, absolute).replace(/\\/g, '/');
      assert(!path.isAbsolute(relative), `generated path must be relative: ${relative}`);
      assert(relative !== '..' && !relative.startsWith('../'), `generated path escapes root: ${relative}`);
      assert(!entry.isSymbolicLink(), `generator must not create symlinks: ${relative}`);
      if (entry.isDirectory()) {
        directories.push(relative);
        visit(absolute);
      } else {
        assert(entry.isFile(), `unsupported generated entry: ${relative}`);
        files.push(relative);
      }
    }
  }
  visit(root);
  return { files, directories };
}

function treeDigest(root) {
  const tree = walk(root);
  const hash = crypto.createHash('sha256');
  for (const relative of tree.files) {
    hash.update(relative);
    hash.update('\0');
    hash.update(fs.readFileSync(path.join(root, relative)));
    hash.update('\0');
  }
  return { ...tree, digest: hash.digest('hex') };
}

function assertStringArray(fixture, field) {
  assert(Array.isArray(fixture[field]) && fixture[field].length > 0, `${fixture.id}.${field} must be a non-empty array`);
  for (const value of fixture[field]) assert.strictEqual(typeof value, 'string', `${fixture.id}.${field} values must be strings`);
}

function validateCatalog(catalog) {
  assert.strictEqual(catalog.schemaVersion, 1, 'catalog schemaVersion must be 1');
  assert(Array.isArray(catalog.fixtures), 'catalog fixtures must be an array');
  assert.strictEqual(catalog.fixtures.length, 8, 'catalog must contain all eight domain fixtures');

  const ids = catalog.fixtures.map(fixture => fixture.id);
  assert.strictEqual(new Set(ids).size, ids.length, 'fixture ids must be unique');
  assert.deepStrictEqual([...new Set(catalog.fixtures.map(fixture => fixture.domain))].sort(), EXPECTED_DOMAINS.sort(), 'domain coverage mismatch');

  const sizeCounts = { small: 0, medium: 0, large: 0 };
  for (const fixture of catalog.fixtures) {
    for (const field of REQUIRED_FIELDS) assert(fixture[field] !== undefined, `${fixture.id || '(unknown)'}.${field} is required`);
    assert(/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(fixture.id), `invalid fixture id: ${fixture.id}`);
    assert(['small', 'medium', 'large'].includes(fixture.sizeClass), `${fixture.id} has invalid sizeClass`);
    sizeCounts[fixture.sizeClass] += 1;
    assert.strictEqual(fixture.generator, 'scripts/generate-workspace-fixtures.js', `${fixture.id} generator mismatch`);

    for (const field of [
      'targetStructure',
      'expectedUsefulFiles',
      'distractingFiles',
      'protectedPathExamples',
      'allowedMutationZones',
      'forbiddenMutationZones',
      'expectedArtifacts',
      'verificationNotes'
    ]) assertStringArray(fixture, field);

    const blockedIds = new Set(fixture.blockedCorrectlyCases.map(item => item.id));
    assert.strictEqual(blockedIds.size, fixture.blockedCorrectlyCases.length, `${fixture.id} blocked case ids must be unique`);
    for (const blockedCase of fixture.blockedCorrectlyCases) {
      assert(blockedCase.id && blockedCase.ticket && blockedCase.reason, `${fixture.id} blocked cases require id, ticket, and reason`);
    }
    for (const ticket of fixture.supportedTicketExamples) {
      const artifacts = Array.isArray(ticket.expectedArtifacts) ? ticket.expectedArtifacts : [];
      const blocked = ticket.blockedCorrectlyCaseId;
      assert(artifacts.length > 0 || blocked, `${fixture.id}/${ticket.id} must expect an artifact or blocked result`);
      for (const artifact of artifacts) assert(fixture.expectedArtifacts.includes(artifact), `${fixture.id}/${ticket.id} references undeclared artifact ${artifact}`);
      if (blocked) assert(blockedIds.has(blocked), `${fixture.id}/${ticket.id} references unknown blocked case ${blocked}`);
    }

    assert(fixture.generation.profile, `${fixture.id} generation profile is required`);
    assert(Number.isInteger(fixture.generation.fullRecordCount) && fixture.generation.fullRecordCount > 0, `${fixture.id} fullRecordCount invalid`);
    assert(Number.isInteger(fixture.generation.testRecordCount) && fixture.generation.testRecordCount > 0, `${fixture.id} testRecordCount invalid`);
    assert(Number.isInteger(fixture.generation.fullEntryTarget) && fixture.generation.fullEntryTarget > 0, `${fixture.id} fullEntryTarget invalid`);
    if (fixture.sizeClass === 'large') {
      assert(fixture.generation.fullEntryTarget > 1000, `${fixture.id} large full target must exceed 1,000 entries`);
      assert(fixture.generation.testRecordCount >= 200, `${fixture.id} large test mode must still exercise bounded snapshots`);
    }
  }
  assert.deepStrictEqual(sizeCounts, { small: 3, medium: 3, large: 2 }, 'size-class coverage mismatch');
}

function validateGeneratedFixture(fixture, fixtureRoot) {
  const tree = treeDigest(fixtureRoot);
  const generatedManifestPath = path.join(fixtureRoot, 'fixture-manifest.json');
  assert(fs.existsSync(generatedManifestPath), `${fixture.id} generated manifest missing`);
  const generatedManifest = JSON.parse(fs.readFileSync(generatedManifestPath, 'utf8'));
  assert.strictEqual(generatedManifest.fixtureId, fixture.id, `${fixture.id} generated manifest id mismatch`);
  assert.strictEqual(generatedManifest.mode, 'test', `${fixture.id} generated manifest mode mismatch`);
  assert.deepStrictEqual(generatedManifest.allowedMutationZones, fixture.allowedMutationZones, `${fixture.id} allowed zones mismatch`);
  assert.deepStrictEqual(generatedManifest.forbiddenMutationZones, fixture.forbiddenMutationZones, `${fixture.id} forbidden zones mismatch`);

  for (const relative of [...fixture.expectedUsefulFiles, ...fixture.distractingFiles, ...fixture.protectedPathExamples]) {
    assert(fs.existsSync(path.join(fixtureRoot, relative)), `${fixture.id} expected generated path missing: ${relative}`);
  }
  for (const artifact of fixture.expectedArtifacts) {
    assert(!fs.existsSync(path.join(fixtureRoot, artifact)), `${fixture.id} expected output must not be pre-generated: ${artifact}`);
  }
  for (const relative of tree.files) {
    assert(/\.(json|md|csv|txt)$/.test(relative), `${fixture.id} generated unsupported file type: ${relative}`);
  }

  const entryCount = tree.files.length + tree.directories.length;
  if (fixture.sizeClass === 'small') assert(entryCount >= 5 && entryCount <= 20, `${fixture.id} small fixture has ${entryCount} entries`);
  if (fixture.sizeClass === 'medium') assert(entryCount >= 100 && entryCount <= 1000, `${fixture.id} medium fixture has ${entryCount} entries`);
  if (fixture.sizeClass === 'large') assert(entryCount > 200, `${fixture.id} bounded large fixture has only ${entryCount} entries`);
  return tree;
}

function main() {
  const catalog = JSON.parse(fs.readFileSync(CATALOG_PATH, 'utf8'));
  validateCatalog(catalog);

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-fixture-catalog-test-'));
  const firstParent = path.join(tempRoot, 'first-parent');
  const secondParent = path.join(tempRoot, 'second-parent');
  const firstOutput = path.join(firstParent, 'fixtures');
  const secondOutput = path.join(secondParent, 'fixtures');
  fs.mkdirSync(firstParent);
  fs.mkdirSync(secondParent);
  fs.writeFileSync(path.join(firstParent, 'sentinel.txt'), 'unchanged\n');

  try {
    const first = runGenerator(['--out', firstOutput, '--all', '--test-mode']);
    assert.strictEqual(first.status, 0, `first generation failed:\n${first.stderr}`);
    const second = runGenerator(['--out', secondOutput, '--all', '--test-mode']);
    assert.strictEqual(second.status, 0, `second generation failed:\n${second.stderr}`);

    assert.strictEqual(fs.readFileSync(path.join(firstParent, 'sentinel.txt'), 'utf8'), 'unchanged\n', 'generator changed a file outside output root');
    assert.deepStrictEqual(fs.readdirSync(firstParent).sort(), ['fixtures', 'sentinel.txt'], 'generator wrote outside its output directory');

    for (const fixture of catalog.fixtures) {
      const firstTree = validateGeneratedFixture(fixture, path.join(firstOutput, fixture.id));
      const secondTree = validateGeneratedFixture(fixture, path.join(secondOutput, fixture.id));
      assert.deepStrictEqual(firstTree.files, secondTree.files, `${fixture.id} generated file list is not deterministic`);
      assert.deepStrictEqual(firstTree.directories, secondTree.directories, `${fixture.id} generated directory list is not deterministic`);
      assert.strictEqual(firstTree.digest, secondTree.digest, `${fixture.id} generated content hash is not deterministic`);
    }

    const unknownOutput = path.join(tempRoot, 'unknown');
    const unknown = runGenerator(['--out', unknownOutput, '--fixture', 'does-not-exist']);
    assert.notStrictEqual(unknown.status, 0, 'unknown fixture id must fail');
    assert(!fs.existsSync(unknownOutput), 'unknown fixture id must not create an output directory');

    const protectedOutput = runGenerator(['--out', path.join(ROOT, 'data'), '--fixture', catalog.fixtures[0].id]);
    assert.notStrictEqual(protectedOutput.status, 0, 'generator must reject tracked data output');

    console.log(`workspace-fixture-catalog-test: PASS (${catalog.fixtures.length} fixtures, deterministic bounded generation)`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(`workspace-fixture-catalog-test: FAIL\n${error.stack || error.message}`);
  process.exit(1);
}
