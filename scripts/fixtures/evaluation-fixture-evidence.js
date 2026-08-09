'use strict';

// Repository-owned fixture evidence.
//
// A registry is an index of retained bytes, never a replacement for them. The
// resolver opens every authoritative file, validates its raw SHA-256, validates
// every internal canonical identity, and walks the complete trial index before
// returning the parsed report. REAL live scoring consumes only this resolver;
// an arbitrary JSON object or operator path is not fixture authority.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { hashCanonical } = require('../structured-allocation-evaluation-scorer');

const FIXTURE_EVIDENCE_REGISTRY_VERSION = 1;
const SUPPORTED_FIXTURE_EVIDENCE_VERSION = 2;
const CANONICAL_REGISTRY_PATH =
  'config/structured-allocation-evaluation-fixture-evidence-v2.json';
const CANONICAL_BUNDLE_ROOT =
  'evidence/structured-allocation-evaluation/fixture-v2';
const FIXTURE_CONCLUSION = 'FIXTURE EVIDENCE SUPPORTS STOP';

class FixtureEvidenceError extends Error {
  constructor(message, detail = {}) {
    super(message);
    this.name = 'FixtureEvidenceError';
    this.code = detail.code || 'FIXTURE_EVIDENCE_REFUSED';
    this.detail = detail;
  }
}

function sha256(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function repositoryRoot() {
  return path.resolve(__dirname, '..', '..');
}

function relativeRepositoryPath(root, target) {
  const relative = path.relative(root, path.resolve(target));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new FixtureEvidenceError('fixture evidence path escapes repository authority',
      { code: 'FIXTURE_EVIDENCE_PATH_OUTSIDE_REPOSITORY' });
  }
  return relative.split(path.sep).join('/');
}

function resolveRepositoryFile(root, relativePath, { mustExist = true } = {}) {
  if (typeof relativePath !== 'string' || !relativePath || path.isAbsolute(relativePath)) {
    throw new FixtureEvidenceError('fixture evidence path must be repository-relative',
      { code: 'FIXTURE_EVIDENCE_PATH_INVALID' });
  }
  const resolved = path.resolve(root, relativePath);
  const normalizedRoot = `${path.resolve(root)}${path.sep}`;
  if (!resolved.startsWith(normalizedRoot)) {
    throw new FixtureEvidenceError('fixture evidence path escapes repository authority',
      { code: 'FIXTURE_EVIDENCE_PATH_OUTSIDE_REPOSITORY' });
  }
  if (!mustExist) return resolved;
  let stat;
  try { stat = fs.lstatSync(resolved); } catch (error) {
    throw new FixtureEvidenceError(`required fixture evidence file is absent: ${relativePath}`,
      { code: 'FIXTURE_EVIDENCE_FILE_MISSING', path: relativePath,
        causeCode: error.code || null });
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new FixtureEvidenceError(
      `fixture evidence path is not a regular repository file: ${relativePath}`,
      { code: 'FIXTURE_EVIDENCE_FILE_NOT_REGULAR', path: relativePath });
  }
  return resolved;
}

function readRetainedFile(root, descriptor, label) {
  if (!descriptor || typeof descriptor.path !== 'string' ||
      typeof descriptor.rawFileSha256 !== 'string') {
    throw new FixtureEvidenceError(`${label} descriptor is incomplete`,
      { code: 'FIXTURE_EVIDENCE_DESCRIPTOR_INCOMPLETE', label });
  }
  const file = resolveRepositoryFile(root, descriptor.path);
  const bytes = fs.readFileSync(file);
  const actual = sha256(bytes);
  if (actual !== descriptor.rawFileSha256) {
    throw new FixtureEvidenceError(`${label} raw-file SHA-256 differs from its registry`,
      { code: 'FIXTURE_EVIDENCE_RAW_HASH_DRIFT', label, path: descriptor.path });
  }
  return Object.freeze({ file, bytes, rawFileSha256: actual });
}

function parseJson(bytes, label) {
  try { return JSON.parse(bytes.toString('utf8')); } catch (error) {
    throw new FixtureEvidenceError(`${label} is not valid JSON`,
      { code: 'FIXTURE_EVIDENCE_JSON_INVALID', label });
  }
}

function assertInternalHash(value, field, label) {
  if (!value || typeof value[field] !== 'string') {
    throw new FixtureEvidenceError(`${label} has no ${field}`,
      { code: 'FIXTURE_EVIDENCE_INTERNAL_HASH_MISSING', label, field });
  }
  const identity = { ...value };
  const stored = identity[field];
  delete identity[field];
  if (hashCanonical(identity) !== stored) {
    throw new FixtureEvidenceError(`${label} canonical ${field} does not reproduce`,
      { code: 'FIXTURE_EVIDENCE_INTERNAL_HASH_DRIFT', label, field });
  }
  return stored;
}

function artifactHashMatches(artifact) {
  if (!artifact || typeof artifact.artifactHash !== 'string') return false;
  const body = { ...artifact };
  const stored = body.artifactHash;
  delete body.artifactHash;
  return sha256(JSON.stringify(body)) === stored;
}

function validateRegistryIdentity(registry) {
  if (!registry || registry.fixtureEvidenceRegistryVersion !==
      FIXTURE_EVIDENCE_REGISTRY_VERSION ||
      registry.fixtureEvidenceVersion !== SUPPORTED_FIXTURE_EVIDENCE_VERSION ||
      registry.evidenceClass !== 'SCORED FIXTURE EVIDENCE' ||
      registry.conclusion !== FIXTURE_CONCLUSION) {
    throw new FixtureEvidenceError('unsupported or incomplete fixture evidence registry',
      { code: 'FIXTURE_EVIDENCE_REGISTRY_UNSUPPORTED' });
  }
  return assertInternalHash(registry, 'registryHash', 'fixture evidence registry');
}

function validateFixtureEvidence({ root, registry, registryBytes = null,
  expectedRegistryFileSha256 = null }) {
  const registryHash = validateRegistryIdentity(registry);
  if (registryBytes && expectedRegistryFileSha256 &&
      sha256(registryBytes) !== expectedRegistryFileSha256) {
    throw new FixtureEvidenceError('fixture evidence registry raw-file SHA-256 drifted',
      { code: 'FIXTURE_EVIDENCE_REGISTRY_RAW_HASH_DRIFT' });
  }
  const files = registry.files || {};
  const manifestFile = readRetainedFile(root, files.manifest, 'fixture manifest');
  const headerFile = readRetainedFile(root, files.runHeader, 'fixture run header');
  const journalFile = readRetainedFile(root, files.journal, 'fixture journal');
  const indexFile = readRetainedFile(root, files.corpusIndex, 'fixture corpus index');
  const reportFile = readRetainedFile(root, files.reportJson, 'fixture JSON report');
  const markdownFile = readRetainedFile(root, files.reportMarkdown,
    'fixture Markdown report');

  const manifest = parseJson(manifestFile.bytes, 'fixture manifest');
  const header = parseJson(headerFile.bytes, 'fixture run header');
  const index = parseJson(indexFile.bytes, 'fixture corpus index');
  const report = parseJson(reportFile.bytes, 'fixture JSON report');

  const manifestHash = assertInternalHash(manifest, 'manifestHash', 'fixture manifest');
  const runHeaderHash = assertInternalHash(header, 'runHeaderHash', 'fixture run header');
  const indexHash = assertInternalHash(index, 'indexHash', 'fixture corpus index');
  const reportHash = assertInternalHash(report, 'reportHash', 'fixture JSON report');
  if (manifest.fixtureEvidenceVersion !== SUPPORTED_FIXTURE_EVIDENCE_VERSION ||
      manifest.manifestVersion !== 2 || manifest.mode !== 'fixture' ||
      manifest.containsResults !== false || !Array.isArray(manifest.trials)) {
    throw new FixtureEvidenceError('retained fixture manifest is not fixture-v2 authority',
      { code: 'FIXTURE_EVIDENCE_MANIFEST_INVALID' });
  }
  if (header.fixtureEvidenceVersion !== SUPPORTED_FIXTURE_EVIDENCE_VERSION ||
      header.manifestHash !== manifestHash ||
      header.manifestFileHash !== manifestFile.rawFileSha256 ||
      header.repositoryCommit !== registry.fixtureSourceCommit ||
      header.mode !== 'fixture') {
    throw new FixtureEvidenceError('fixture run header disagrees with retained authority',
      { code: 'FIXTURE_EVIDENCE_RUN_HEADER_DRIFT' });
  }
  if (index.fixtureEvidenceVersion !== SUPPORTED_FIXTURE_EVIDENCE_VERSION ||
      index.manifestHash !== manifestHash || index.runHeaderHash !== runHeaderHash ||
      index.sourceCommit !== header.repositoryCommit ||
      !Array.isArray(index.artifacts) || index.artifacts.length !== manifest.trials.length ||
      index.trialCount !== manifest.trials.length || index.exclusionCount !== 0) {
    throw new FixtureEvidenceError('fixture corpus index disagrees with retained authority',
      { code: 'FIXTURE_EVIDENCE_CORPUS_INDEX_DRIFT' });
  }

  const seenPaths = new Set();
  const seenTrials = new Set();
  const artifactHashes = [];
  for (const entry of index.artifacts) {
    if (!entry || typeof entry.trialId !== 'string' || seenTrials.has(entry.trialId) ||
        typeof entry.path !== 'string' || seenPaths.has(entry.path)) {
      throw new FixtureEvidenceError('fixture corpus index has duplicate/ambiguous identity',
        { code: 'FIXTURE_EVIDENCE_CORPUS_INDEX_AMBIGUOUS' });
    }
    seenTrials.add(entry.trialId);
    seenPaths.add(entry.path);
    const retained = readRetainedFile(root, entry, `fixture trial ${entry.trialId}`);
    const artifact = parseJson(retained.bytes, `fixture trial ${entry.trialId}`);
    if (artifact.trialId !== entry.trialId || artifact.artifactHash !== entry.artifactHash ||
        artifact.manifestHash !== manifestHash || artifact.scoredRunHash !== runHeaderHash ||
        artifact.sourceCommit !== header.repositoryCommit ||
        artifact.mode !== 'fixture' || !artifactHashMatches(artifact)) {
      throw new FixtureEvidenceError(`fixture trial ${entry.trialId} identity drifted`,
        { code: 'FIXTURE_EVIDENCE_ARTIFACT_DRIFT', trialId: entry.trialId });
    }
    artifactHashes.push(artifact.artifactHash);
  }
  const corpusHash = hashCanonical(artifactHashes.sort());
  if (corpusHash !== index.corpusHash ||
      report.corpusIntegrity?.corpusHash !== corpusHash ||
      report.corpusIntegrity?.trials !== manifest.trials.length ||
      report.manifestHash !== manifestHash || report.scoredRunHash !== runHeaderHash ||
      report.repositoryCommit !== header.repositoryCommit ||
      report.fixtureEvidenceVersion !== SUPPORTED_FIXTURE_EVIDENCE_VERSION ||
      report.frozenDecision?.decision !== 'STOP') {
    throw new FixtureEvidenceError('fixture scored report provenance does not close',
      { code: 'FIXTURE_EVIDENCE_REPORT_PROVENANCE_DRIFT' });
  }
  if (registry.fixtureManifestHash !== manifestHash ||
      registry.fixtureRunHeaderHash !== runHeaderHash ||
      registry.fixtureCorpusHash !== corpusHash || registry.fixtureReportHash !== reportHash ||
      registry.fixtureCorpusIndexHash !== indexHash ||
      registry.trialCount !== manifest.trials.length || registry.exclusionCount !== 0) {
    throw new FixtureEvidenceError('fixture registry identities disagree with actual evidence',
      { code: 'FIXTURE_EVIDENCE_REGISTRY_IDENTITY_DRIFT' });
  }
  // Journal bytes are retained as provenance even though journal timestamps
  // and duration are not scoring inputs. Requiring a non-empty, line-oriented
  // journal prevents a summary-only capsule from masquerading as a corpus.
  if (journalFile.bytes.length === 0 || !journalFile.bytes.toString('utf8').includes('\n')) {
    throw new FixtureEvidenceError('fixture journal is absent or empty',
      { code: 'FIXTURE_EVIDENCE_JOURNAL_INVALID' });
  }
  if (markdownFile.bytes.length === 0) {
    throw new FixtureEvidenceError('fixture Markdown report is absent or empty',
      { code: 'FIXTURE_EVIDENCE_MARKDOWN_INVALID' });
  }
  return Object.freeze({
    fixtureEvidenceVersion: registry.fixtureEvidenceVersion,
    registryHash,
    fixtureSourceCommit: header.repositoryCommit,
    fixtureManifestHash: manifestHash,
    fixtureRunHeaderHash: runHeaderHash,
    fixtureCorpusHash: corpusHash,
    fixtureCorpusIndexHash: indexHash,
    fixtureReportHash: reportHash,
    fixtureReportRawFileSha256: reportFile.rawFileSha256,
    fixtureMarkdownRawFileSha256: markdownFile.rawFileSha256,
    conclusion: FIXTURE_CONCLUSION,
    manifest: Object.freeze(manifest),
    header: Object.freeze(header),
    report: Object.freeze(report),
    registry: Object.freeze(registry)
  });
}

function resolveFixtureEvidenceForLiveManifest({
  manifest, root = repositoryRoot()
}) {
  const binding = manifest?.source?.fixtureEvidence;
  if (!binding || binding.version !== SUPPORTED_FIXTURE_EVIDENCE_VERSION ||
      binding.registryPath !== CANONICAL_REGISTRY_PATH ||
      typeof binding.registryHash !== 'string' ||
      typeof binding.registryRawFileSha256 !== 'string') {
    throw new FixtureEvidenceError(
      'live manifest carries no supported repository-owned fixture evidence authority',
      { code: 'FIXTURE_EVIDENCE_LIVE_BINDING_MISSING' });
  }
  const registryPath = resolveRepositoryFile(root, binding.registryPath);
  const registryBytes = fs.readFileSync(registryPath);
  const actualRegistryRawHash = sha256(registryBytes);
  if (actualRegistryRawHash !== binding.registryRawFileSha256) {
    throw new FixtureEvidenceError('manifest-bound fixture registry bytes drifted',
      { code: 'FIXTURE_EVIDENCE_REGISTRY_RAW_HASH_DRIFT' });
  }
  const registry = parseJson(registryBytes, 'fixture evidence registry');
  const resolved = validateFixtureEvidence({
    root, registry, registryBytes,
    expectedRegistryFileSha256: binding.registryRawFileSha256
  });
  const expected = {
    registryHash: binding.registryHash,
    fixtureManifestHash: manifest.source.fixtureManifestHash,
    fixtureRunHeaderHash: binding.runHeaderHash,
    fixtureCorpusHash: manifest.source.fixtureCorpusHash,
    fixtureReportHash: manifest.source.fixtureReportHash,
    fixtureReportRawFileSha256: binding.reportRawFileSha256,
    fixtureMarkdownRawFileSha256: binding.markdownRawFileSha256,
    conclusion: manifest.source.fixtureDecision
  };
  for (const [field, value] of Object.entries(expected)) {
    if (resolved[field] !== value) {
      throw new FixtureEvidenceError(`live manifest fixture binding drifted on ${field}`,
        { code: 'FIXTURE_EVIDENCE_LIVE_BINDING_DRIFT', field });
    }
  }
  return resolved;
}

function writeExclusiveJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`,
    { flag: 'wx', mode: 0o644 });
}

function recordFixtureEvidenceBundle({
  root = repositoryRoot(),
  bundleRoot = CANONICAL_BUNDLE_ROOT,
  registryPath = CANONICAL_REGISTRY_PATH,
  manifestSourcePath = 'config/structured-allocation-evaluation-scored-v2.json'
} = {}) {
  const bundle = path.resolve(root, bundleRoot);
  const manifestSource = resolveRepositoryFile(root, manifestSourcePath);
  const retainedManifest = path.join(bundle, 'fixture-manifest-v2.json');
  if (fs.existsSync(retainedManifest)) {
    throw new FixtureEvidenceError('fixture-v2 manifest is already retained; refusing overwrite',
      { code: 'FIXTURE_EVIDENCE_WRITE_ONCE' });
  }
  fs.copyFileSync(manifestSource, retainedManifest, fs.constants.COPYFILE_EXCL);

  const relative = target => relativeRepositoryPath(root, target);
  const descriptor = target => {
    const bytes = fs.readFileSync(target);
    return Object.freeze({ path: relative(target), rawFileSha256: sha256(bytes) });
  };
  const manifest = parseJson(fs.readFileSync(retainedManifest), 'fixture manifest');
  const headerPath = path.join(bundle, 'scored-run-header.json');
  const journalPath = path.join(bundle, 'scored-run-journal.jsonl');
  const reportPath = path.join(bundle,
    'structured-allocation-scored-fixture-report-v2.json');
  const markdownPath = path.join(bundle,
    'structured-allocation-scored-fixture-report-v2.md');
  const header = parseJson(fs.readFileSync(headerPath), 'fixture run header');
  const report = parseJson(fs.readFileSync(reportPath), 'fixture report');
  const trialsDir = path.join(bundle, 'trials');
  const artifacts = fs.readdirSync(trialsDir).filter(file => file.endsWith('.json')).sort()
    .map(file => {
      const target = path.join(trialsDir, file);
      const retained = descriptor(target);
      const artifact = parseJson(fs.readFileSync(target), `fixture trial ${file}`);
      if (!artifactHashMatches(artifact)) {
        throw new FixtureEvidenceError(`fixture trial ${file} hash does not reproduce`,
          { code: 'FIXTURE_EVIDENCE_ARTIFACT_DRIFT' });
      }
      return Object.freeze({ ...retained, trialId: artifact.trialId,
        artifactHash: artifact.artifactHash });
    });
  if (artifacts.length !== manifest.trials.length) {
    throw new FixtureEvidenceError('fixture corpus is incomplete before retention',
      { code: 'FIXTURE_EVIDENCE_CORPUS_INCOMPLETE' });
  }
  const corpusHash = hashCanonical(artifacts.map(entry => entry.artifactHash).sort());
  if (report.corpusIntegrity?.corpusHash !== corpusHash) {
    throw new FixtureEvidenceError('fixture report and retained artifacts disagree',
      { code: 'FIXTURE_EVIDENCE_CORPUS_HASH_DRIFT' });
  }
  const index = {
    fixtureCorpusIndexVersion: 1,
    fixtureEvidenceVersion: SUPPORTED_FIXTURE_EVIDENCE_VERSION,
    evidenceClass: 'SCORED FIXTURE EVIDENCE',
    sourceCommit: header.repositoryCommit,
    manifestHash: manifest.manifestHash,
    runHeaderHash: header.runHeaderHash,
    corpusHash,
    trialCount: artifacts.length,
    exclusionCount: 0,
    artifacts
  };
  index.indexHash = hashCanonical(index);
  const indexPath = path.join(bundle, 'fixture-corpus-index-v2.json');
  writeExclusiveJson(indexPath, index);

  const registry = {
    fixtureEvidenceRegistryVersion: FIXTURE_EVIDENCE_REGISTRY_VERSION,
    fixtureEvidenceVersion: SUPPORTED_FIXTURE_EVIDENCE_VERSION,
    evidenceClass: 'SCORED FIXTURE EVIDENCE',
    fixtureSourceCommit: header.repositoryCommit,
    fixtureManifestHash: manifest.manifestHash,
    fixtureRunHeaderHash: header.runHeaderHash,
    fixtureCorpusHash: corpusHash,
    fixtureCorpusIndexHash: index.indexHash,
    fixtureReportHash: report.reportHash,
    conclusion: FIXTURE_CONCLUSION,
    trialCount: artifacts.length,
    exclusionCount: 0,
    files: {
      manifest: descriptor(retainedManifest),
      runHeader: descriptor(headerPath),
      journal: descriptor(journalPath),
      corpusIndex: descriptor(indexPath),
      reportJson: descriptor(reportPath),
      reportMarkdown: descriptor(markdownPath)
    }
  };
  registry.registryHash = hashCanonical(registry);
  const registryOutput = resolveRepositoryFile(root, registryPath, { mustExist: false });
  writeExclusiveJson(registryOutput, registry);
  const registryBytes = fs.readFileSync(registryOutput);
  const validated = validateFixtureEvidence({
    root, registry, registryBytes,
    expectedRegistryFileSha256: sha256(registryBytes)
  });
  return Object.freeze({ ...validated,
    registryPath, registryRawFileSha256: sha256(registryBytes) });
}

module.exports = {
  CANONICAL_BUNDLE_ROOT,
  CANONICAL_REGISTRY_PATH,
  FIXTURE_CONCLUSION,
  FIXTURE_EVIDENCE_REGISTRY_VERSION,
  FixtureEvidenceError,
  SUPPORTED_FIXTURE_EVIDENCE_VERSION,
  artifactHashMatches,
  recordFixtureEvidenceBundle,
  repositoryRoot,
  resolveFixtureEvidenceForLiveManifest,
  sha256,
  validateFixtureEvidence,
  validateRegistryIdentity
};
